//! Persists model and provider configuration.
use std::{collections::HashSet, str::FromStr};

use sqlx::{Row, Sqlite, Transaction};

use crate::{
    model::{model_hash, normalize_model_input, ModelConfig, ModelConfigInput, ModelType},
    Error, Result,
};

use super::{now_ms, Store};

const MODEL_COLUMNS: &str = r#"
    model_hash, sort_order, display_name, group_name, model_type, base_url, use_full_url, api_key, tooltip_data,
    model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
    openai_extra_params_json, custom_headers_enabled, custom_headers_json,
    anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
    max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
    thinking_budget_tokens, created_at_ms, updated_at_ms
"#;

impl Store {
    pub async fn models(&self) -> Result<Vec<ModelConfig>> {
        let query =
            format!("SELECT {MODEL_COLUMNS} FROM model_configs ORDER BY sort_order, display_name");
        sqlx::query(&query)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(model_from_row)
            .collect()
    }

    pub async fn model(&self, hash: &str) -> Result<Option<ModelConfig>> {
        let query = format!("SELECT {MODEL_COLUMNS} FROM model_configs WHERE model_hash = ?");
        sqlx::query(&query)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .map(model_from_row)
            .transpose()
    }

    pub async fn create_model(&self, input: &ModelConfigInput) -> Result<ModelConfig> {
        let mut models = self.create_models(std::slice::from_ref(input)).await?;
        Ok(models.remove(0))
    }

    pub async fn create_models(&self, inputs: &[ModelConfigInput]) -> Result<Vec<ModelConfig>> {
        if inputs.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let mut normalized = Vec::with_capacity(inputs.len());
        let mut hashes = HashSet::with_capacity(inputs.len());
        for input in inputs {
            let input = normalize_model_input(input)?;
            let hash = model_hash(&input)?;
            if !hashes.insert(hash.clone()) {
                return Err(Error::Config("model configurations must be unique".into()));
            }
            normalized.push((hash, input));
        }
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        for (hash, input) in &normalized {
            insert_model(&mut transaction, hash, input, now).await?;
        }
        transaction.commit().await?;

        let mut saved = Vec::with_capacity(normalized.len());
        for (hash, _) in normalized {
            saved.push(self.model(&hash).await?.expect("inserted model must exist"));
        }
        Ok(saved)
    }

    pub async fn create_models_if_missing(&self, inputs: &[ModelConfigInput]) -> Result<usize> {
        let mut normalized = Vec::with_capacity(inputs.len());
        let mut hashes = HashSet::with_capacity(inputs.len());
        for input in inputs {
            let input = normalize_model_input(input)?;
            let hash = model_hash(&input)?;
            if hashes.insert(hash.clone()) {
                normalized.push((hash, input));
            }
        }
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        let mut inserted = 0;
        for (hash, input) in &normalized {
            inserted += usize::from(
                insert_model_with_conflict(&mut transaction, hash, input, now, true).await?,
            );
        }
        transaction.commit().await?;
        Ok(inserted)
    }

    pub async fn update_model(
        &self,
        current_hash: &str,
        input: &ModelConfigInput,
    ) -> Result<ModelConfig> {
        let current = self
            .model(current_hash)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("model {current_hash}")))?;
        let input = normalize_model_input(input)?;
        let next_hash = model_hash(&input)?;
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        if next_hash != current.model_hash {
            sqlx::query("UPDATE llm_calls SET model_hash = NULL WHERE model_hash = ?")
                .bind(&current.model_hash)
                .execute(&mut *transaction)
                .await?;
        }
        let result = sqlx::query(
            r#"UPDATE model_configs SET
                model_hash = ?, sort_order = ?, display_name = ?, group_name = ?, model_type = ?, base_url = ?,
                use_full_url = ?, api_key = ?, tooltip_data = ?, model_id = ?, reasoning_effort = ?,
                openai_endpoint = ?, openai_extra_params_enabled = ?, openai_extra_params_json = ?,
                custom_headers_enabled = ?, custom_headers_json = ?,
                anthropic_extra_params_enabled = ?, anthropic_extra_params_json = ?,
                context_window_tokens = ?, max_completion_tokens = ?, anthropic_max_tokens = ?,
                anthropic_thinking_effort = ?, thinking_budget_tokens = ?, updated_at_ms = ?
            WHERE model_hash = ?"#,
        )
        .bind(&next_hash)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.group_name)
        .bind(input.model_type.as_str())
        .bind(&input.base_url)
        .bind(input.use_full_url)
        .bind(&input.api_key)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(&input.openai_endpoint)
        .bind(input.openai_extra_params_enabled)
        .bind(serde_json::to_string(&input.openai_extra_params)?)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(input.anthropic_extra_params_enabled)
        .bind(serde_json::to_string(&input.anthropic_extra_params)?)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_completion_tokens.map(to_i64).transpose()?)
        .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(now)
        .bind(current_hash)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("model {current_hash}")));
        }
        transaction.commit().await?;
        Ok(self
            .model(&next_hash)
            .await?
            .expect("updated model must exist"))
    }

    pub async fn delete_model(&self, hash: &str) -> Result<()> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("UPDATE llm_calls SET model_hash = NULL WHERE model_hash = ?")
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        let result = sqlx::query("DELETE FROM model_configs WHERE model_hash = ?")
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("model {hash}")));
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn clear_models(&self) -> Result<usize> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE llm_calls SET model_hash = NULL WHERE model_hash IN (SELECT model_hash FROM model_configs)",
        )
        .execute(&mut *transaction)
        .await?;
        let result = sqlx::query("DELETE FROM model_configs")
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(usize::try_from(result.rows_affected()).unwrap_or(0))
    }

    pub async fn reorder_models(&self, model_hashes: &[String]) -> Result<Vec<ModelConfig>> {
        let current = self.models().await?;
        let current_hashes = current
            .iter()
            .map(|model| model.model_hash.as_str())
            .collect::<HashSet<_>>();
        let requested_hashes = model_hashes
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if model_hashes.len() != current.len()
            || requested_hashes.len() != current.len()
            || requested_hashes != current_hashes
        {
            return Err(Error::Config(
                "model configuration changed; refresh and try sorting again".into(),
            ));
        }

        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        for (index, hash) in model_hashes.iter().enumerate() {
            sqlx::query(
                "UPDATE model_configs SET sort_order = ?, updated_at_ms = ? WHERE model_hash = ?",
            )
            .bind(i64::try_from(index + 1).expect("model order fits in i64"))
            .bind(now)
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.models().await
    }
}

pub(super) async fn insert_model(
    transaction: &mut Transaction<'_, Sqlite>,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
) -> Result<()> {
    insert_model_with_conflict(transaction, hash, input, now, false).await?;
    Ok(())
}

async fn insert_model_with_conflict(
    transaction: &mut Transaction<'_, Sqlite>,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
    ignore_existing: bool,
) -> Result<bool> {
    let mut statement = String::from(
        r#"INSERT INTO model_configs(
            model_hash, sort_order, display_name, group_name, model_type, base_url, use_full_url, api_key, tooltip_data,
            model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
            openai_extra_params_json, custom_headers_enabled, custom_headers_json,
            anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
            max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
            thinking_budget_tokens, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    );
    if ignore_existing {
        statement.push_str(" ON CONFLICT(model_hash) DO NOTHING");
    }
    let result = sqlx::query(&statement)
        .bind(hash)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.group_name)
        .bind(input.model_type.as_str())
        .bind(&input.base_url)
        .bind(input.use_full_url)
        .bind(&input.api_key)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(&input.openai_endpoint)
        .bind(input.openai_extra_params_enabled)
        .bind(serde_json::to_string(&input.openai_extra_params)?)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(input.anthropic_extra_params_enabled)
        .bind(serde_json::to_string(&input.anthropic_extra_params)?)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_completion_tokens.map(to_i64).transpose()?)
        .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(now)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    Ok(result.rows_affected() == 1)
}

fn model_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ModelConfig> {
    Ok(ModelConfig {
        model_hash: row.try_get("model_hash")?,
        sort_order: row.try_get("sort_order")?,
        display_name: row.try_get("display_name")?,
        group_name: row.try_get("group_name")?,
        model_type: ModelType::from_str(row.try_get("model_type")?)?,
        base_url: row.try_get("base_url")?,
        use_full_url: row.try_get("use_full_url")?,
        api_key: row.try_get("api_key")?,
        tooltip_data: row.try_get("tooltip_data")?,
        model_id: row.try_get("model_id")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        openai_endpoint: row.try_get("openai_endpoint")?,
        openai_extra_params_enabled: row.try_get("openai_extra_params_enabled")?,
        openai_extra_params: serde_json::from_str(
            row.try_get::<String, _>("openai_extra_params_json")?
                .as_str(),
        )?,
        custom_headers_enabled: row.try_get("custom_headers_enabled")?,
        custom_headers: serde_json::from_str(
            row.try_get::<String, _>("custom_headers_json")?.as_str(),
        )?,
        anthropic_extra_params_enabled: row.try_get("anthropic_extra_params_enabled")?,
        anthropic_extra_params: serde_json::from_str(
            row.try_get::<String, _>("anthropic_extra_params_json")?
                .as_str(),
        )?,
        context_window_tokens: optional_u64(&row, "context_window_tokens")?,
        max_completion_tokens: optional_u64(&row, "max_completion_tokens")?,
        anthropic_max_tokens: optional_u64(&row, "anthropic_max_tokens")?,
        anthropic_thinking_effort: row.try_get("anthropic_thinking_effort")?,
        thinking_budget_tokens: optional_u64(&row, "thinking_budget_tokens")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn optional_u64(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Option<u64>> {
    row.try_get::<Option<i64>, _>(column)?
        .map(|value| {
            u64::try_from(value).map_err(|_| Error::Config(format!("{column} cannot be negative")))
        })
        .transpose()
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Config("token value is too large".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_input(group_name: Option<&str>) -> ModelConfigInput {
        ModelConfigInput {
            sort_order: 0,
            display_name: "Test Model".into(),
            group_name: group_name.map(String::from),
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "test-key".into(),
            tooltip_data: "Test Model".into(),
            model_id: "test-model".into(),
            reasoning_effort: None,
            openai_endpoint: crate::model::OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: None,
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    #[tokio::test]
    async fn clear_models_removes_every_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let mut second = model_input(None);
        second.model_id = "other-model".into();
        store
            .create_models(&[model_input(None), second])
            .await
            .unwrap();
        assert_eq!(store.clear_models().await.unwrap(), 2);
        assert!(store.models().await.unwrap().is_empty());
        assert_eq!(store.clear_models().await.unwrap(), 0);
    }

    /// 导入时同一文件内的重复项和数据库已有项都只保留一份。
    #[tokio::test]
    async fn import_models_skips_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let input = model_input(None);

        assert_eq!(
            store
                .create_models_if_missing(&[input.clone(), input.clone()])
                .await
                .unwrap(),
            1
        );
        assert_eq!(store.create_models_if_missing(&[input]).await.unwrap(), 0);
        assert_eq!(store.models().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn import_matches_endpoint_and_model_instead_of_credentials_or_name() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let original = store.create_model(&model_input(None)).await.unwrap();
        let mut incoming = model_input(Some("Imported"));
        incoming.use_full_url = false;
        incoming.base_url = "https://example.com/v1".into();
        incoming.display_name = "Renamed".into();
        incoming.api_key = "new-key".into();
        incoming.custom_headers_enabled = true;
        incoming.custom_headers = serde_json::json!({"X-Test": "new-value"});
        let preview = store
            .preview_model_import(&[incoming.clone()])
            .await
            .unwrap();
        assert_eq!(preview.conflicts.len(), 1);
        assert!(store
            .import_models(&[incoming.clone()], None)
            .await
            .is_err());
        assert_eq!(store.models().await.unwrap().len(), 1);
        let skipped = store
            .import_models(
                &[incoming.clone()],
                Some(super::super::ModelImportPolicy::Skip),
            )
            .await
            .unwrap();
        assert_eq!(skipped.skipped, 1);
        assert_eq!(store.models().await.unwrap()[0].api_key, "test-key");
        let overwritten = store
            .import_models(
                &[incoming],
                Some(super::super::ModelImportPolicy::Overwrite),
            )
            .await
            .unwrap();
        assert_eq!(overwritten.overwritten, 1);
        let saved = store.models().await.unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].api_key, "new-key");
        assert_eq!(saved[0].display_name, "Renamed");
        assert_eq!(saved[0].custom_headers["X-Test"], "new-value");
        assert_eq!(saved[0].group_name.as_deref(), Some("Imported"));
        assert_eq!(saved[0].created_at_ms, original.created_at_ms);
        assert_eq!(saved[0].sort_order, original.sort_order);
    }

    #[tokio::test]
    async fn import_normalizes_equivalent_urls_but_keeps_distinct_protocol_endpoints() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        store.create_model(&model_input(None)).await.unwrap();
        let mut equivalent = model_input(None);
        equivalent.base_url = "https://EXAMPLE.COM:443/v1/chat/completions".into();
        equivalent.model_id = " test-model ".into();
        let mut distinct = model_input(None);
        distinct.use_full_url = false;
        distinct.base_url = "https://example.com/v1".into();
        distinct.openai_endpoint = crate::model::OPENAI_RESPONSES_ENDPOINT.into();
        let preview = store
            .preview_model_import(&[equivalent, distinct.clone()])
            .await
            .unwrap();
        assert_eq!(preview.conflicts.len(), 1);
        assert_eq!(
            preview.conflicts[0].request_url,
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            store
                .import_models(&[distinct], None)
                .await
                .unwrap()
                .imported,
            1
        );
    }

    #[tokio::test]
    async fn import_policy_handles_file_duplicates_and_distinct_endpoints() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let first = model_input(None);
        let mut last = first.clone();
        last.api_key = "last-key".into();
        let mut distinct = first.clone();
        distinct.base_url = "https://other.example.com/v1/chat/completions".into();
        let inputs = [first.clone(), last.clone(), distinct.clone()];
        assert_eq!(
            store
                .preview_model_import(&inputs)
                .await
                .unwrap()
                .conflicts
                .len(),
            1
        );
        assert!(store.import_models(&inputs, None).await.is_err());
        assert!(store.models().await.unwrap().is_empty());
        let result = store
            .import_models(&inputs, Some(super::super::ModelImportPolicy::Skip))
            .await
            .unwrap();
        assert_eq!(
            (result.imported, result.overwritten, result.skipped),
            (2, 0, 1)
        );
        assert_eq!(
            store
                .models()
                .await
                .unwrap()
                .iter()
                .find(|model| model.base_url == first.base_url)
                .unwrap()
                .api_key,
            first.api_key
        );
        let result = store
            .import_models(
                &[first, last],
                Some(super::super::ModelImportPolicy::Overwrite),
            )
            .await
            .unwrap();
        assert_eq!(
            (result.imported, result.overwritten, result.skipped),
            (0, 2, 0)
        );
        assert_eq!(store.models().await.unwrap().len(), 2);
        assert!(store
            .models()
            .await
            .unwrap()
            .iter()
            .any(|model| model.api_key == "last-key"));
        let mut new_model = distinct;
        new_model.model_id = "different-model".into();
        assert_eq!(
            store
                .import_models(&[new_model], None)
                .await
                .unwrap()
                .imported,
            1
        );
    }

    #[tokio::test]
    async fn import_failure_rolls_back_overwrites_and_new_models() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let original = store.create_model(&model_input(None)).await.unwrap();
        let mut incoming = model_input(None);
        incoming.api_key = "replacement-key".into();
        let mut invalid = model_input(None);
        invalid.model_id = "new-model".into();
        invalid.context_window_tokens = Some(u64::MAX);
        assert!(store
            .import_models(
                &[incoming, invalid],
                Some(super::super::ModelImportPolicy::Overwrite)
            )
            .await
            .is_err());
        let saved = store.models().await.unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].model_hash, original.model_hash);
        assert_eq!(saved[0].api_key, original.api_key);
    }

    #[tokio::test]
    async fn import_overwrite_replaces_all_matching_configurations() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let first = model_input(None);
        let mut variant = first.clone();
        variant.display_name = "Variant".into();
        store
            .create_models(&[first.clone(), variant])
            .await
            .unwrap();
        let mut incoming = first;
        incoming.api_key = "replacement".into();
        let result = store
            .import_models(
                &[incoming],
                Some(super::super::ModelImportPolicy::Overwrite),
            )
            .await
            .unwrap();
        assert_eq!(result.overwritten, 1);
        assert_eq!(store.models().await.unwrap().len(), 1);
    }

    /// 分组名是纯展示字段:入库时去除首尾空白、空串归一为 NULL,
    /// 更新分组名不得改变模型身份哈希。
    #[tokio::test]
    async fn group_name_round_trips_without_changing_model_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        let created = store
            .create_model(&model_input(Some("  My Group  ")))
            .await
            .unwrap();
        assert_eq!(created.group_name.as_deref(), Some("My Group"));

        let renamed = store
            .update_model(&created.model_hash, &model_input(Some("Renamed")))
            .await
            .unwrap();
        assert_eq!(renamed.model_hash, created.model_hash);
        assert_eq!(renamed.group_name.as_deref(), Some("Renamed"));

        let cleared = store
            .update_model(&created.model_hash, &model_input(Some("   ")))
            .await
            .unwrap();
        assert_eq!(cleared.model_hash, created.model_hash);
        assert_eq!(cleared.group_name, None);
    }
}
