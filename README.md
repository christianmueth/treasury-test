This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Product Architecture

Mate-E is a reasoning-time search/planning system, not a single-pass chatbot wrapper.

Product positioning: Mate-E is a replay-governed adaptive tutoring platform. It uses LLMs for tutoring, persistent student-state modeling for personalization, and MuZero/LightZero-inspired replay and value evaluation to improve tutoring decisions under strict governance.

Current production truth: tutoring uses a bounded heuristic world model by default, plus a Muon-style helper loop and replay-governed reranking. A LightZero-trained world model can now be loaded into the live scorer through `TUTORING_LIGHTZERO_ARTIFACT_PATH`, but LightZero is not in the serving path unless that artifact is explicitly configured.

Avoid claiming that the product is already a full autonomous MuZero agent. The correct claim is that the product uses MuZero-style principles such as policy priors, candidate actions, value estimation, replay, and governed rollout evaluation.

The implementation contract for that architecture lives in `docs/REASONING_ENGINE_ARCHITECTURE.md`.

The student-facing product roadmap and bounded feature rollout plan live in `docs/PRODUCT_FEATURE_MAP.md`.

The visual companion to that roadmap lives in `docs/VISUAL_PRODUCT_ARCHITECTURE_MAP.md`.

Two repo rules follow from that contract:

- App and frontend code only interact with stable product APIs and shared contracts.
- Research code, training artifacts, notebooks, and dormant experiments are not product dependencies.

Adaptive capability changes are also governed by an explicit review and rollout doctrine. Contributors should read `CONTRIBUTING.md` and `docs/ADAPTIVE_CHANGE_REVIEW.md` before changing adaptive behavior or authority.

Real adaptive shadow telemetry exports are operationalized in `docs/SHADOW_EXPORT_WORKFLOW.md`.

Recurring post-launch replay, shadow, drift, and recovery monitoring is defined in `docs/OPERATIONAL_REVIEW_CADENCE.md`.

Pre-launch deployment verification is defined in `docs/GO_LIVE_CHECKLIST.md`.

The executable weekly governance bundle can be generated with `npm run reasoning:report:weekly`.

## Deployment Posture

The current production posture is:

- `TUTORING_ADAPTIVE_RERANK_SHADOW=1`
- `TUTORING_ADAPTIVE_RERANK_ENABLED=0`
- `TUTORING_LIGHTZERO_ARTIFACT_PATH=<optional path to offline-trained LightZero world-model artifact JSON>`
- `INTERNAL_OPERATOR_CLERK_USER_IDS=<comma-separated Clerk user ids for replay/governance access>`

That means the website ships as a complete tutoring product with live adaptive shadow scoring, while heuristic tutoring remains authoritative until replay evidence justifies a bounded trial.

The replay console and governance APIs are intended to remain internal-only. In production, operator access is restricted by `INTERNAL_OPERATOR_CLERK_USER_IDS`.

Deployable product features now include:

- AI tutoring and hints
- student-state memory
- misconception tracking
- recovery tracking
- replay analytics
- adaptive shadow scoring
- readiness dashboard
- exportable shadow datasets

Full MCTS or autonomous planner authority is intentionally not yet authoritative in the live product.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Alcohol Label Review Prototype

The standalone treasury take-home prototype lives at `/label-review`.

What it does:

- uploads PNG, JPG, or PDF alcohol labels
- accepts application metadata as JSON
- extracts candidate fields from the label
- compares brand name, class/type, ABV, proof, net contents, and government warning
- supports reviewing multiple labels in a single submission session by pairing uploaded files with a JSON array of application objects
- includes bundled sample scenarios for fast reviewer evaluation

Architecture:

- Extraction: convert a label image or PDF into candidate structured fields.
- Deterministic validation: compare extracted values against submitted application data using normalization, fuzzy matching, numeric comparison, and government warning rules.
- Reviewer experience: present overall verdicts, side-by-side application vs. extracted values, confidence cues, and manual-review states.

The intent is to keep the model in the extraction layer while letting deterministic rules drive the actual review outcome.

Environment notes:

- `OPENAI_API_KEY` enables image-based review for PNG/JPG and structured extraction for PDFs
- searchable PDFs can still be reviewed without `OPENAI_API_KEY` using local text extraction plus heuristic validation
- in production, the model-backed extraction layer could be replaced with local OCR services or Azure-hosted models depending on agency network requirements
- the prototype is intentionally standalone and does not integrate with COLA, auth, or long-term storage

Local smoke test:

1. Start the app:

```bash
npm start
```

2. In another terminal, run:

```bash
npm run label-review:smoketest
```

Optional deployed target:

```bash
npm run label-review:smoketest -- --base "https://YOUR_DEPLOYED_DOMAIN"
```

Optional full-file review with a real label fixture:

```bash
npm run label-review:smoketest -- --file "C:\path\to\label.pdf"
```

The default smoke test verifies the public `/label-review` page and the `/api/label-review` validation contract without requiring a local fixture file. If you pass `--file`, it will also submit that real PNG, JPG, or PDF label to the live API.

Local validation note:

- In local testing on this machine, the bundled `perfect-match.png` sample completed a successful review in about 3.4 seconds. This is an anecdotal sample result, not a performance guarantee.

## What I Prioritized

- A reviewer-centered workflow over backend integration.
- Clear pass, manual-review, and reject states over pretending the model is always certain.
- Fast local handling for searchable PDFs before falling back to AI-assisted extraction.
- A standalone architecture so the extraction layer can be swapped later without changing the review UI.

## Known Limitations

- PNG and JPG review currently depend on an OpenAI-compatible vision endpoint, which may be unsuitable in restricted government networks without a local model or approved internal service.
- The government warning check is strict about text and the all-caps `GOVERNMENT WARNING:` heading, but typography verification was intentionally deferred because reliable font-weight and sizing analysis requires image-layout processing beyond the scope of this prototype.
- The UI is designed for fast human review, but it does not currently measure or guarantee sub-5-second latency across all environments.
- No COLA workflow integration, persistence, or federal deployment controls are included in this prototype by design.

## Production Considerations

- Replace or augment the current image OCR path with an internal OCR or vision service that can run in restricted network environments.
- Add explicit timing telemetry so performance claims are measured rather than inferred.
- Expand validation rules for beverage-specific requirements such as imports, bottler address, and class-specific ABV exceptions.
- Add operator audit logs, retention policies, and a structured human-review queue before treating the tool as more than a proof of concept.

## Flashcards Local Smoketest

Run this to verify RunPod output is parseable (bypasses auth using `FLASHCARDS_TEST_KEY`).

1) Terminal A:

```bash
npm run dev
```

2) Terminal B:

```bash
set FLASHCARDS_TEST_KEY=localtest
npm run flashcards:smoketest -- --text "Water expands when it freezes..."
```

PowerShell equivalent:

```powershell
$env:FLASHCARDS_TEST_KEY = "localtest"
npm run flashcards:smoketest -- --text "Water expands when it freezes..."
```

To test a deployed endpoint (including YouTube URL → transcript → flashcards):

```powershell
$env:FLASHCARDS_TEST_KEY = "localtest"
npm run flashcards:smoketest -- --base "https://YOUR_DEPLOYED_DOMAIN" --url "https://www.youtube.com/watch?v=VIDEO_ID" --cards 10
```

Confirm the response shows `origin="youtube"` and includes `timings` like `supadata_ms`, `llm_flashcards_ms`, and `total_ms`.

If the AI endpoint is misbehaving, the response will include an error code like `AI_NO_FLASHCARDS`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
