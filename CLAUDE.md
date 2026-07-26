# FitCheckCDK — CLAUDE.md

AWS **CDK v2 (TypeScript)** infrastructure for **FitCheck**, a web app for fitness coaches
to manage students (attach students to a coach, track workout history, set goals, and
write or LLM-draft planned-then-performed workout sessions the coach approves/edits).

**Read `ProjectInfra.md` in this repo for the full architecture and the reasoning behind
every design decision.** This file is the quick-start; that doc is the source of truth.

## Sibling repos (all parent-level under `GitHub/`, one logical project)
- **FitCheckCDK** (this repo) — infrastructure.
- **FitCheckBackend** — Python Lambda handlers. Packaged/deployed from here via `LAMBDA_PATH`.
- **FitCheckAssets** — React (Vite) SPA frontend. Deployed via `FRONTEND_PATH` (later).

For cross-repo work, launch Claude from the `GitHub/` parent so all three are visible.

## Layout
- `bin/fit_check_cdk.ts` — app entry; loads `.env` via dotenv, sets region/account, wires stacks.
- `lib/data-stack.ts` — **DataStack**: 4 DynamoDB tables + GSIs (stable/precious data).
- `lib/app-stack.ts` — **AppStack**: Cognito + API Gateway (+ Cognito authorizer) + Lambdas.
- `test/` — jest CDK assertion tests.

Stack structure is **3 stacks**: `DataStack` + `AppStack` + `FrontendStack` (planned). Each
CDK `Stack` = one CloudFormation stack. Cross-stack table refs are passed as constructor props.

## Environment / conventions
- **`.env` is required and gitignored.** Copy `.env.example` → `.env` and set absolute paths:
  - `LAMBDA_PATH` → the backend source dir (`.../FitCheckBackend/src`) — this is what gets zipped & deployed.
  - `FRONTEND_PATH` → the built frontend dir (`.../FitCheckAssets/dist`) — used later.
  - `CDK_DEFAULT_REGION=us-west-2` (target region).
- Lambda packaging uses `Code.fromAsset(process.env.LAMBDA_PATH)` — it **zips the backend `src/` as-is**.
  No `pip install` happens; `boto3` comes from the Lambda runtime. Adding a third-party runtime
  dep means switching to bundling (`PythonFunction` or a Docker bundle) — not set up yet.

## Commands
```bash
npm install
npm run build            # tsc type-check
npx jest                 # CDK assertion tests
npx cdk synth            # synthesize (needs LAMBDA_PATH dir to exist)
npx cdk bootstrap        # one-time per account/region, before first deploy
npx cdk deploy --all     # deploy (needs AWS creds)
```

## Current state
- `DataStack` + `AppStack` built, **synth clean**. `/students` (GET, POST) wired end-to-end:
  Cognito → API Gateway (Cognito authorizer) → Python Lambda → `Users` table.
- **Nothing deployed yet** — synth/test only. First deploy needs creds + `cdk bootstrap`.
- Table removal policies are `DESTROY` while iterating; switch `Users`/`Sessions` to `RETAIN`
  before real data.

## Next (per ProjectInfra.md §7 build order)
- Remaining student/session CRUD routes; **Cognito post-confirmation trigger** to create the
  coach's own `Users` record on sign-up.
- SQS-backed async LLM draft flow (`POST /drafts` → worker Lambda → `GET /drafts/{id}`).
- `FrontendStack` (S3 + CloudFront).
