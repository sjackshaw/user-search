# Project Guideline: Expanding User Search with GenAI

**AI Implementer:** Claude Opus 4.6
**Date:** February 20, 2026
**Last Updated:** February 23, 2026

### 1. Objective

Evolve the existing vector search application into a conversational GenAI platform. This will be achieved by adding a comprehensive logging layer for all ETL and source data changes, and integrating a locally-hosted, open-source LLM (Ollama with Llama 3.1) to enable natural language queries, summarization, and historical analysis.

### 2. Current State Analysis

*   **Architecture**: The project is a Dockerized application orchestrated via `docker-compose`. It consists of a PostgreSQL database with the `pgvector` extension, four consolidated Node.js ETL **line** services, and a Node.js/Express web application. Each line service handles both its primary data source table and its associated activity/sync log table within a single container, sharing one SBERT model instance and one Postgres connection pool — reducing per-container memory by ~350–500 MB compared to running them as separate containers.
*   **Data Sources**:
    *   `active_directory`
    *   `netforum_members`
    *   `external_users`
    *   `distribution_groups`
    *   `distribution_group_sync_logs`
*   **Search Mechanism**: Search is powered by `Xenova/all-MiniLM-L6-v2` SBERT embeddings stored in `pgvector`. The application performs cosine similarity searches across a `UNION` of all source tables.
*   **User Interface**: A single-page web application (`index.html`) provides a search bar and a detail overlay. It interacts with a backend API for search (`/api/search`) and lookup (`/api/lookup`).
*   **Limitation**: The current system is limited to semantic vector search and direct lookups. It cannot answer analytical or historical questions (e.g., "What changed for this user last week?") and lacks conversational capabilities.

### 3. Target Architecture

The new architecture will introduce a robust logging layer and a dedicated GenAI service, all running within Docker.

*   **Logging Layer (Postgres)**:
    *   `etl_job_logs`: A central table to record the status, duration, and results of every ETL run.
    *   `source_change_logs`: A detailed, immutable log of all detected changes (creations, updates, deletions) for records in `active_directory` and `netforum_members`.
    *   `chat_messages`: A table to store conversation history for the GenAI chat interface.
*   **LLM Service (Ollama Container)**:
    *   An official `ollama/ollama` Docker container will run locally.
    *   It will serve the `llama3.1:8b` model via a REST API on port `11434`.
    *   A persistent Docker volume will store downloaded models.
*   **GenAI Service (New Node.js Container)**:
    *   A new service responsible for handling all conversational logic.
    *   It will receive user queries from the main app.
    *   **Workflow**:
        1.  Classify user intent (e.g., user lookup, ETL status check, change history query).
        2.  Gather relevant context from the appropriate Postgres tables (source data, job logs, change logs).
        3.  Construct a detailed prompt including the retrieved context.
        4.  Send the prompt to the Ollama service for response generation.
        5.  Store the conversation in the `chat_messages` table.
        6.  Return the final answer to the user.

### 4. Implementation Plan & Sequence of Steps

#### ✅ Phase 1 — Logging Foundation (Complete — February 23, 2026)

1.  **Create Logging Schemas** ✅
    *   Added `infra/db/init/10_logging_tables.sql` defining:
        *   `etl_job_logs` — records service, phase, target table, status (`running` / `completed` / `failed`), record counts (processed, created, updated, deleted), error message, start/finish timestamps. Indexed on `service`, `status`, and `started_at DESC`.
        *   `source_change_logs` — immutable append-only log of every detected change (created / updated / deleted) across all four primary tables. Stores `source_table`, `email`, `change_type`, `field_name`, `old_value`, `new_value`, `detected_at`, and `etl_job_id` FK. Indexed on `email`, `source_table`, `detected_at DESC`, and `change_type`.
    *   Applied to the running Postgres instance via `docker exec`.

2.  **Enhance ETL Line Services** ✅
    *   All four `vectorize.js` files updated with identical `startJob()` / `completeJob()` / `failJob()` helper functions.
    *   `runPrimary()` now:
        *   Pre-loads the existing table into a `Map<email, record>` before processing.
        *   Detects creates (email absent from DB), field-level updates (per-column comparison via `normaliseValue()`), and deletes (email in DB but absent from incoming data).
        *   Writes each change to `source_change_logs` within the same transaction as the upsert.
        *   Deletes removed records from the primary table.
        *   No longer calls `TRUNCATE` — data is fully managed via upsert + targeted deletes.
    *   `runLogs()` continues to truncate-and-reload (appropriate for append-only log tables) but now wraps in `etl_job_logs` entries.
    *   Tracked fields per service: `active_directory` (`first_name`, `last_name`, `type`, `enabled`, `locked`, `passwordlastreset`), `netforum_members` (`first_name`, `last_name`, `type`, `enabled`, `last_login`), `external_users` (`first_name`, `last_name`, `type`, `enabled`, `sponsor`), `distribution_groups` (`name`, `alias`, `contacts` as serialised JSON).
    *   All four ETL containers rebuilt and redeployed; first run logged 8 completed jobs.

3.  **Integrate Logs into UI** ✅
    *   `GET /api/lookup` now executes `LOOKUP_SQL` and `CHANGE_LOGS_SQL` in parallel (`Promise.all`) and returns `{ records[], changeLogs[] }`.
    *   New `GET /api/etl-jobs` endpoint returns the 50 most recent `etl_job_logs` entries (most recent first), serialised with camelCase field names.
    *   Frontend (`index.html`) detail overlay now renders a colour-coded **Change History** section below the activity logs:
        *   Green badge = `created`, blue = `updated`, red = `deleted`.
        *   Update entries show a field-level diff (`old_value → new_value`).
        *   Timestamp and job ID shown per entry.
        *   Uses the same 5-entry preview + progressive-disclosure "More…" pattern as existing activity logs.
    *   App container rebuilt and redeployed; `/api/etl-jobs` and updated `/api/lookup` verified responding correctly.

---

#### 🔲 Phase 2 — GenAI Service (Next)

4.  **Create Chat Storage Schema**:
    *   Add `infra/db/init/11_chat_tables.sql` to define the `chat_messages` table:
        *   `id`, `session_id` (UUID to group a conversation), `role` (`user` | `assistant`), `content` (TEXT), `created_at`.
        *   Index on `session_id` for fast conversation retrieval.
    *   Apply to the running Postgres instance via `docker exec` (same pattern as step 1).

5.  **Deploy Ollama Service**:
    *   Create `docker-compose.genai.yml` defining the `ollama` service:
        *   Image: `ollama/ollama`.
        *   Named volume `ollama_models` mounted at `/root/.ollama` for model persistence across restarts.
        *   Exposes port `11434`.
        *   Joins the same Docker network as `postgres` and the `genai` service.
    *   After first `docker compose up`, pull the model once: `docker exec user-search-ollama-1 ollama pull llama3.1:8b`.

6.  **Build GenAI Service**:
    *   Create `services/genai/` with `Dockerfile`, `package.json`, and `index.js`.
    *   Express server exposing `POST /api/chat` (accepts `{ sessionId, message }`).
    *   **Workflow inside `/api/chat`**:
        1.  Classify user intent from the message text (user lookup / ETL status / change history / general).
        2.  Retrieve relevant context from Postgres based on intent:
            *   User lookup → query `active_directory`, `netforum_members`, `external_users`.
            *   ETL status → query `etl_job_logs` (recent runs, any failures).
            *   Change history → query `source_change_logs` filtered by email or date range.
        3.  Load recent conversation history from `chat_messages` for the given `sessionId`.
        4.  Assemble a system prompt + context + history and POST to `http://ollama:11434/api/chat`.
        5.  Persist both the user message and the assistant response to `chat_messages`.
        6.  Return the response to the caller (streaming optional in v1).
    *   Add the `genai` service to `docker-compose.genai.yml`, with `depends_on: [postgres, ollama]`.

7.  **Implement Chat UI**:
    *   Add a **Chat** panel to `index.html` alongside the existing search interface.
    *   The panel maintains a `sessionId` (generated client-side with `crypto.randomUUID()`).
    *   Sends `POST /api/chat` requests through the existing app container, which proxies to the `genai` service (add a `/api/chat` proxy route to `services/app/src/index.js`).
    *   Renders streamed or full responses in a scrollable conversation thread.
    *   Example prompts surfaced in the UI: *"What changed for john.smith@example.com last week?"*, *"Show me the last ETL run for Active Directory"*, *"Who are the members of the Executives distribution group?"*.

8.  **Final Integration & Testing**:
    *   Add `ollama` and `genai` services to the existing compose invocation (or document a combined command) so all services start together.
    *   End-to-end test with natural language queries that require data from multiple sources and logs (e.g., *"What changed for John Smith last week?"*, *"Show me failed ETL runs"*, *"Who sponsors Jane Doe's external account?"*).
    *   Refine the GenAI service system prompt based on response quality observed during testing.
