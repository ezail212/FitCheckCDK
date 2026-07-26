# FitCheck — Project Infrastructure Plan

A web app for fitness coaches to manage their students: attach students to a coach,
view workout history, set goals, and write (or LLM-draft) planned-then-performed
workout sessions that the coach approves/edits.

- **Region:** us-west-2
- **IaC:** AWS CDK (TypeScript)
- **Backend:** Python (Lambda) — AWS Lambda Powertools for logging/tracing/validation
- **Frontend:** React (Vite SPA), hosted on S3 + CloudFront
- **Auth:** Amazon Cognito (User Pool) — coaches only for MVP
- **Stage:** Side project / MVP, but designed to scale

---

## 1. Architecture Overview

```
                 ┌──────────────────────────┐
                 │  React SPA (Vite)         │
                 │  S3 + CloudFront          │
                 └───────────┬──────────────┘
                             │  JWT (Cognito token) on every request
                             ▼
                 ┌──────────────────────────┐
                 │  API Gateway              │
                 │  + Cognito Authorizer     │
                 └───────────┬──────────────┘
             ┌───────────────┼─────────────────────┐
             ▼               ▼                     ▼
     ┌─────────────┐  ┌─────────────┐      ┌──────────────────┐
     │ CRUD Lambdas│  │ POST /drafts│      │ GET /drafts/{id} │
     │ (sync)      │  │ (enqueue)   │      │ (poll status)    │
     └──────┬──────┘  └──────┬──────┘      └────────┬─────────┘
            │                │                       │
            ▼                ▼                       ▼
     ┌─────────────┐   ┌──────────┐          ┌──────────────┐
     │  DynamoDB   │   │   SQS    │──────────▶│ Worker Lambda│
     │  (4 tables) │   │ (+ DLQ)  │          │  calls LLM   │
     └─────────────┘   └──────────┘          └──────┬───────┘
            ▲                                        │
            └────────────────────────────────────────┘
                     writes draft result + status
```

Two API shapes:
- **Fast CRUD** (students, plans, history) → synchronous Lambda.
- **LLM draft generation** → asynchronous, because API Gateway caps a synchronous
  request at **29 seconds** and an LLM draft can exceed that.

---

## 2. Authentication (Cognito)

- **User Pool** holds coaches; handles sign-up, login, password reset, email verification.
- **Identity Pool** — NOT needed for now; ignore.
- Login flow: React → Cognito → JWT → sent as `Authorization: Bearer <token>` →
  API Gateway **Cognito Authorizer** validates it → Lambda receives the verified `userId`.
- **Every query is scoped to the calling coach** (`userId` from the token) — this is the
  security backbone that prevents one coach reading another coach's students.
- Frontend integration via AWS **Amplify UI** (pre-built login component) or the Cognito SDK.
- **Students do not log in** in the MVP, but are modeled as first-class `Users` records so
  auth can be attached later with no migration.

---

## 3. Data Model (DynamoDB — 4 tables)

Pragmatic multi-table design (not pure single-table) for clarity and easy iteration.

### 3.1 `Users`
Coaches and students in one table, distinguished by a `roles` set.

| Field      | Notes                                                        |
|------------|-------------------------------------------------------------|
| `userId`   | **PK**. e.g. `u_123`                                         |
| `roles`    | Set: `["coach"]`, `["student"]`, or `["coach","student"]`    |
| `coachId`  | The coach who owns this student record                      |
| `name`     |                                                             |
| `email`    | Per-record. **Coach:** login credential (tied to Cognito). **Student:** contact email for outbound reminders (SES) — no login. Kept separate by design. |
| `notifications` | Student opt-in/prefs for reminders (e.g. `{ sessionReminders: true }`) |
| `goal`     | Fitness goal (free text or structured)                      |
| `profile`  | Basic info: age, weight, height, experience, notes, etc.    |
| `createdAt`|                                                             |

- **One person = one item.** Coaches and students are separate items, each with its own
  `email`. `roles` distinguishes them (`["coach"]` vs `["student"]`) — there's no shared row,
  so no need for separate coach/student email columns.
- **GSI `byCoach`**: `PK = coachId` → returns all students of a coach in one query.
- **Self-coaching:** a user with `roles: ["coach","student"]` and `coachId == userId`.
  They appear as their own student via the `byCoach` GSI. No special-casing needed.

### 3.2 `Sessions`
Durable workout records — time-series, "planned-then-performed".

| Field       | Notes                                                       |
|-------------|-------------------------------------------------------------|
| `studentId` | **PK**                                                      |
| `sk`        | **SK** = `sessionDate#sessionId` → cheap date-range queries |
| `coachId`   | Owning coach — enables the coach-wide upcoming-sessions view |
| `status`    | `planned | in_progress | completed`                         |
| `source`    | `coach | llm_draft`                                        |
| `plan`      | Prescribed: `[{ exercise, sets, targetReps, targetLoad }]`  |
| `performed` | Actual: `[{ exercise, sets: [{ reps, load }] }]`            |
| `notes`     |                                                             |

- **GSI `byCoachDate`**: `PK = coachId`, `SK = sessionDate#sessionId`. Powers the coach
  dashboard — query `sessionDate >= today` to get **all upcoming sessions across all of a
  coach's students**, sorted by date, in one call (filter `status in [planned, in_progress]`).
- Per-student history still uses the base table (`PK = studentId`, date-range on `sk`).

Feeding the LLM = one `Query` for the student's recent `performed` data.

Example record:
```json
{
  "studentId": "u_123",
  "sk": "2026-07-28#s_987",
  "status": "planned",
  "source": "llm_draft",
  "plan":     [{ "exercise": "Back Squat", "sets": 4, "targetReps": 8, "targetLoad": "70%" }],
  "performed":[{ "exercise": "Back Squat", "sets": [{ "reps": 8, "load": "100kg" }] }],
  "notes": ""
}
```

### 3.3 `Drafts`
Transient LLM task tracking; separate from durable `Sessions`.

| Field       | Notes                                                       |
|-------------|-------------------------------------------------------------|
| `draftId`   | **PK**                                                      |
| `studentId` |                                                             |
| `coachId`   | For scoping/authorization                                   |
| `status`    | `QUEUED → IN_PROGRESS → COMPLETED` / `FAILED`               |
| `error`     | Populated on `FAILED`                                       |
| `result`    | Generated `plan` when `COMPLETED`                           |
| `ttl`       | DynamoDB **TTL** auto-deletes stale drafts (free cleanup)   |

On coach approval, a `Drafts.result` is written into a real `Sessions` record; the draft expires.

### 3.4 `Assets` (later / optional)
Pointers to S3 blobs — form-check videos, progress photos, exported PDFs.
S3 is reserved for genuine large binary data, NOT for session logs.

---

## 4. Async Draft Generation Flow

1. `POST /drafts` → write `Drafts` record `status: QUEUED`, return **`202`** + `draftId`.
2. Enqueue a message on **SQS**.
3. **Worker Lambda** consumes it → sets `IN_PROGRESS` → calls the LLM →
   writes `result` and sets `COMPLETED` (or `FAILED` + `error`).
4. Frontend **polls** `GET /drafts/{draftId}` until `COMPLETED`, then shows the `plan`
   for the coach to approve/edit. (Streaming can be added later.)

**Why SQS:** automatic retries + durability. Failures redeliver or land in a **dead-letter
queue** instead of vanishing. A few lines of CDK, worth it.

**LLM provider:** deferred (Amazon Bedrock vs Anthropic API — decide later). Exercise
knowledge base = external library, out of scope for now.

---

## 5. API Surface (draft)

| Method & Route             | Type  | Purpose                                  |
|----------------------------|-------|------------------------------------------|
| `POST /students`           | sync  | Create a student under the coach         |
| `GET /students`            | sync  | List the coach's students (GSI `byCoach`)|
| `GET /students/{id}`       | sync  | Student detail (info + goal)             |
| `PUT /students/{id}`       | sync  | Update basic info / goal                 |
| `GET /students/{id}/sessions` | sync | Workout history (date range)           |
| `POST /students/{id}/sessions`| sync | Coach writes a session manually         |
| `PUT /sessions/{id}`       | sync  | Edit / mark performed / complete         |
| `POST /drafts`             | async | Request an LLM draft → `202` + `draftId` |
| `GET /drafts/{id}`         | sync  | Poll draft status/result                 |
| `GET /dashboard/upcoming`  | sync  | Upcoming sessions across all the coach's students (GSI `byCoachDate`) |

All routes behind the Cognito Authorizer; every handler scopes by the token's `userId`.

---

## 6. CDK Stack Breakdown (TypeScript)

**Chosen structure: 3 stacks** (each CDK `Stack` = one CloudFormation stack). Data is kept
separate so app redeploys can never risk the tables; auth/API/queue are consolidated to avoid
excessive cross-stack export juggling for a side project.

- **`DataStack`** ✅ *(built)* — 4 DynamoDB tables + GSIs + TTL config. Stable/precious.
- **`AppStack`** — Cognito User Pool + authorizer, API Gateway, CRUD Lambdas, draft Lambdas,
  SQS queue + DLQ, worker Lambda. This is what changes most often.
- **`FrontendStack`** — S3 bucket + CloudFront distribution for the Vite SPA.

Cross-stack references (e.g. `AppStack` using `DataStack`'s tables) are wired automatically by
CDK via CloudFormation Exports/Imports, which also enforces deploy order (Data → App → Frontend).
Can split `AppStack` into finer stacks later if it grows; merging is harder than splitting.

---

## 7. Suggested Build Order

1. **CDK skeleton** + `DataStack` (tables) — foundation.
2. **AuthStack** (Cognito) + `ApiStack` with one authenticated CRUD route end-to-end.
3. Remaining **student & session CRUD** routes.
4. **Vite SPA** with Cognito login + student list + session history views.
5. **Coach dashboard** — upcoming sessions across all students (`GET /dashboard/upcoming`).
6. **QueueStack** + async draft flow (`POST /drafts`, worker Lambda, `GET /drafts/{id}`).
7. **LLM integration** in the worker (choose Bedrock vs Anthropic).
8. Coach approve/edit draft → write `Sessions` record.
9. **FrontendStack** deploy (S3 + CloudFront).
10. Polish: `Assets`/S3 for media, streaming drafts, student login, **student performance
    dashboards** — as needed.

---

## 8. Open / Deferred Decisions

- LLM provider: Amazon Bedrock vs Anthropic API.
- Exercise knowledge base: external library (out of scope for now).
- Student login: deferred; data model is ready for it.
- Streaming LLM output instead of polling: later enhancement.
- **Student performance dashboards** (progress charts, volume/PR trends): deferred to a later
  stage. The `Sessions.performed` data already captures what these will visualize, so no
  data-model change is needed now — it's a frontend + aggregation effort later.
- **Session reminder emails via Amazon SES** (to students): deferred. The `Users.email` +
  `Users.notifications` fields already capture the student contact + opt-in, and the
  `byCoachDate` GSI already finds upcoming sessions — so a scheduled Lambda (EventBridge cron)
  can query due sessions and send SES emails with no data-model change. SES requires domain/
  email verification and moving out of the sandbox before it can email arbitrary recipients.
```