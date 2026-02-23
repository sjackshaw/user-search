# Project Guideline: Expanding User Search with GenAI

**AI Implementer:** Claude Opus 4.6
**Date:** February 20, 2026

### 1. Objective

Evolve the existing vector search application into a conversational GenAI platform. This will be achieved by adding a comprehensive logging layer for all ETL and source data changes, and integrating a locally-hosted, open-source LLM (Ollama with Llama 3.1) to enable natural language queries, summarization, and historical analysis.

### 2. Current State Analysis

*   **Architecture**: The project is a Dockerized application orchestrated via `docker-compose`. It consists of a PostgreSQL database with the `pgvector` extension, multiple Node.js ETL services for different data sources, and a Node.js/Express web application.
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

This project will be executed in the following sequence:

1.  **Create Logging Schemas**:
    *   Add a new SQL file (`infra/db/init/07_logging_tables.sql`) to define the `etl_job_logs` and `source_change_logs` tables.

2.  **Enhance ETL Services**:
    *   Modify the `active-directory` ETL service (`vectorize.js`) to:
        *   Implement change-detection logic by comparing incoming data against the existing state in Postgres.
        *   Write start, completion, and failure records to the `etl_job_logs` table.
        *   Write all detected data changes to the `source_change_logs` table.
    *   Repeat the process for the `netForum` ETL service.

3.  **Integrate Logs into UI**:
    *   Update the main application's `/api/lookup` endpoint to also retrieve records from `source_change_logs` for a given user.
    *   Modify the frontend (`index.html`) to display a "Change History" section in the user detail panel.

4.  **Deploy Ollama Service**:
    *   Create a `docker-compose.genai.yml` file to define the `ollama` service.
    *   Ensure it uses a named volume for model persistence and exposes port `11434`.
    *   Document the one-time command needed to pull the model: `docker exec <container_name> ollama pull llama3.1:8b`.

5.  **Build GenAI Service**:
    *   Create a new service directory: `services/genai`.
    *   Add a `Dockerfile`, `package.json`, and `index.js`.
    *   Implement the core logic: an Express server with a `/api/chat` endpoint that performs the intent classification and context retrieval workflow described in the Target Architecture.
    *   Add this new service to the `docker-compose.genai.yml` file, ensuring it can communicate with both `postgres` and `ollama`.

6.  **Create Chat Storage Schema**:
    *   Add a new SQL file (`infra/db/init/08_chat_tables.sql`) to define the `chat_messages` table for storing conversation history.

7.  **Implement Chat UI**:
    *   Add a new chat interface component to the main application's `index.html`.
    *   This UI will send user messages to the GenAI service's `/api/chat` endpoint and display the streaming response.

8.  **Final Integration & Testing**:
    *   Create a master `docker-compose.yml` that includes all services (app, postgres, etls, ollama, genai) or provide instructions for running them together.
    *   Perform end-to-end testing with natural language queries that require data from multiple sources and logs (e.g., "What changed for John Smith last week?", "Show me failed ETL runs for Active Directory").
    *   Refine the system prompt in the GenAI service to improve the accuracy and formatting of responses.
