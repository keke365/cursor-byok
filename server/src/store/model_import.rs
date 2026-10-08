//! Imports model backups by resolved API endpoint and model ID.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    model::{model_hash, normalize_model_input, resolve_request_url, ModelConfigInput},
    Error, Result,
};

use super::{models::insert_model, now_ms, Store};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelImportPolicy {
    Overwrite,
    Skip,
}

#[derive(Debug, Serialize)]
pub struct ModelImportConflict {
    pub display_name: String,
    pub model_id: String,
    pub request_url: String,
}

#[derive(Debug, Serialize)]
pub struct ModelImportPreview {
    pub total: usize,
    pub conflicts: Vec<ModelImportConflict>,
}

#[derive(Debug, Serialize)]
pub struct ModelImportResult {
    pub imported: usize,
    pub overwritten: usize,
    pub skipped: usize,
    pub total: usize,
}

type ImportKey = (String, String);

fn import_key(request_url: &str, model_id: String) -> Result<ImportKey> {
    let url = url::Url::parse(request_url)
        .map_err(|error| Error::Config(format!("invalid model request URL: {error}")))?;
    Ok((url.to_string(), model_id))
}

fn normalize_import(inputs: &[ModelConfigInput]) -> Result<Vec<(ImportKey, ModelConfigInput)>> {
    if inputs.is_empty() {
        return Err(Error::Config("at least one model is required".into()));
    }
    inputs
        .iter()
        .map(|input| {
            let input = normalize_model_input(input)?;
            let url = resolve_request_url(
                input.model_type,
                &input.base_url,
                &input.openai_endpoint,
                input.use_full_url,
            )?;
            Ok((import_key(&url, input.model_id.clone())?, input))
        })
        .collect()
}

// Only identity and ordering metadata are needed while writing the import transaction.
struct ExistingModel {
    hash: String,
    sort_order: i64,
    created_at_ms: i64,
}

impl Store {
    pub async fn preview_model_import(
        &self,
        inputs: &[ModelConfigInput],
    ) -> Result<ModelImportPreview> {
        let normalized = normalize_import(inputs)?;
        let mut seen = self
            .models()
            .await?
            .into_iter()
            .map(|model| import_key(&model.request_url()?, model.model_id))
            .collect::<Result<HashSet<_>>>()?;
        let conflicts = normalized
            .into_iter()
            .filter_map(|(key, input)| {
                (!seen.insert(key.clone())).then_some(ModelImportConflict {
                    display_name: input.display_name,
                    model_id: key.1,
                    request_url: key.0,
                })
            })
            .collect();
        Ok(ModelImportPreview {
            total: inputs.len(),
            conflicts,
        })
    }

    pub async fn import_models(
        &self,
        inputs: &[ModelConfigInput],
        policy: Option<ModelImportPolicy>,
    ) -> Result<ModelImportResult> {
        let normalized = normalize_import(inputs)?;
        let _write = self.writes.lock().await;
        let mut existing: BTreeMap<ImportKey, Vec<ExistingModel>> = BTreeMap::new();
        for model in self.models().await? {
            existing
                .entry(import_key(&model.request_url()?, model.model_id)?)
                .or_default()
                .push(ExistingModel {
                    hash: model.model_hash,
                    sort_order: model.sort_order,
                    created_at_ms: model.created_at_ms,
                });
        }
        // No rows may be written until the user has explicitly resolved every conflict.
        if policy.is_none() {
            let mut seen = existing.keys().cloned().collect::<HashSet<_>>();
            if normalized.iter().any(|(key, _)| !seen.insert(key.clone())) {
                return Err(Error::Config(
                    "model import conflicts; preview and choose overwrite or skip".into(),
                ));
            }
        }
        let now = now_ms();
        let mut transaction = self.pool.begin().await?;
        let mut result = ModelImportResult {
            imported: 0,
            overwritten: 0,
            skipped: 0,
            total: inputs.len(),
        };
        for (key, mut input) in normalized {
            let matches = existing.get(&key);
            if matches.is_some() && policy == Some(ModelImportPolicy::Skip) {
                result.skipped += 1;
                continue;
            }
            let created_at_ms = if let Some(matches) = matches {
                input.sort_order = matches[0].sort_order;
                matches[0].created_at_ms
            } else {
                now
            };
            let hash = model_hash(&input)?;
            if let Some(matches) = matches {
                for old in matches {
                    // Match the normal model-edit behavior when the runtime identity changes.
                    if old.hash != hash {
                        sqlx::query("UPDATE llm_calls SET model_hash = NULL WHERE model_hash = ?")
                            .bind(&old.hash)
                            .execute(&mut *transaction)
                            .await?;
                    }
                    sqlx::query("DELETE FROM model_configs WHERE model_hash = ?")
                        .bind(&old.hash)
                        .execute(&mut *transaction)
                        .await?;
                }
                result.overwritten += 1;
            } else {
                result.imported += 1;
            }
            insert_model(&mut transaction, &hash, &input, now).await?;
            if created_at_ms != now {
                sqlx::query("UPDATE model_configs SET created_at_ms = ? WHERE model_hash = ?")
                    .bind(created_at_ms)
                    .bind(&hash)
                    .execute(&mut *transaction)
                    .await?;
            }
            // Subsequent entries in the same backup must follow the same conflict policy.
            existing.insert(
                key,
                vec![ExistingModel {
                    hash,
                    sort_order: input.sort_order,
                    created_at_ms,
                }],
            );
        }
        transaction.commit().await?;
        Ok(result)
    }
}
