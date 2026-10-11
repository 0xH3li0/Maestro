---
title: Local Models
description: Run Maestro's housekeeping tasks on models that live on your machine or on a model server you already run, instead of spending agent turns on them.
icon: hard-drive
---

Maestro does a lot of small model work besides your agents' own turns: it names new tabs, writes context summaries, turns a plain-English request into a shell command, and more. By default most of that runs through the **Utility Agent**, an ordinary agent spawn. **Local Models** lets you point each of those jobs somewhere else: a small model Maestro downloads and runs itself, or a model server you already run, such as Ollama or LM Studio.

Open it from **Settings -> Local Models**, or run **Open Local Models Settings** from the command palette. It is a core part of Maestro, not an Encore Feature, and it starts empty.

<Note>
	**Nothing downloads on its own.** Opening the tab, or enabling anything else in Maestro, fetches
	no model and calls no server. Every download, every server probe, and every test is a button you
	press. Every task also starts where it was: the ones that already ran through the Utility Agent stay
	there, and every new task starts **Off**.
</Note>

The tab has three sections: **Models**, **Endpoints**, and **Assignments**.

## Models

Models are files Maestro downloads, checks, and runs on this machine. The top of the section shows how much disk the installed models use, how many are installed, and how many need attention. Below that is the catalog, grouped by kind:

| Kind            | Model                          | Size     | License                   |
| --------------- | ------------------------------ | -------- | ------------------------- |
| Text generation | Qwen3 1.7B Instruct (Q4_K_M)   | 1.1 GB   | Apache-2.0                |
| Embeddings      | BGE Small (English)            | 34.7 MB  | MIT                       |
| Embeddings      | EmbeddingGemma 300M            | 218.7 MB | Gemma Terms of Use        |
| Classifiers     | Llama Prompt Guard 2 22M       | 81.2 MB  | Llama 4 Community License |
| Classifiers     | DeBERTa v3 Prompt Injection v2 | 747.2 MB | Apache-2.0                |
| Speech-to-text  | Parakeet TDT 0.6B (English)    | 661.3 MB | CC-BY-4.0                 |
| Speech-to-text  | Whisper Base (English)         | 208.5 MB | Apache-2.0                |
| Text-to-speech  | Kokoro 82M                     | 326.1 MB | Apache-2.0                |
| Wake word       | openWakeWord Base              | 2.4 MB   | Apache-2.0                |
| Wake word       | Wake phrase: "Hey Jarvis"      | 1.3 MB   | CC-BY-NC-SA-4.0           |

Each kind lists what can use it, and each installed model lists what uses it right now: the tasks assigned to it, and the A Cappella voice slot when voice can use it. Each row has **Download**, **Pause**, **Cancel**, **Re-verify**, and **Remove**, with its size and status.

Every file comes from a pinned revision and is checked against a SHA-256 recorded in the app, so a file altered in transit fails to install rather than running. **Re-verify** hashes the files again and never deletes or re-downloads anything.

**Removing a model a task uses warns first.** The warning names the tasks that would stop working, and you choose **Remove anyway** or **Keep it**.

<Warning>
	Two entries are listed but not usable yet: **Qwen3 1.7B** needs a llama.cpp runtime and **Kokoro
	82M** needs a phoneme front end, and neither is part of this build. Their rows say so. Until they
	ship, use an [endpoint](#endpoints) for text generation.
</Warning>

The speech and wake word models are the same files A Cappella uses. Installing them here or from [Voice Setup](./voice-mode#downloading-the-models) is the same install, and either page shows it.

## Endpoints

An endpoint is a model server you run yourself. Maestro sends it requests and downloads nothing. If you already run one, it is the fastest way to a working text model. Three kinds are supported:

| Kind              | Default address          | Notes                                     |
| ----------------- | ------------------------ | ----------------------------------------- |
| Ollama            | `http://127.0.0.1:11434` |                                           |
| LM Studio         | `http://127.0.0.1:1234`  |                                           |
| OpenAI-compatible | none, you enter it       | Any `/v1` server, such as LiteLLM or vLLM |

- **Detect local servers** looks for Ollama and LM Studio on this machine and offers each one it finds with an **Add** button. It runs only when you click it.
- **Add** and **Edit** open a small form: name, kind, base URL, and an optional API key variable. **Test** sends a one-token request and shows the latency or the error before you save.
- Each endpoint has an **enabled** switch, the list of models it serves, and **Test**, **Refresh models**, **Edit**, and **Remove**. A disabled endpoint stays configured and is never called.

**The API key is never stored in the endpoint.** You give the NAME of an environment variable, and Maestro reads its value from **Settings -> Environment** at the moment it sends a request. Settings files end up in backups and debug packages, so a key written into one would leak through all of them. To rotate a key, change it in one place.

## Assignments

Assignments choose what each task runs on. There is one row per task, each with a source picker and a readiness line.

The picker only offers sources that can do the job:

- **Off**: the feature does not use a model.
- **Utility Agent**: the task's existing agent path, for tasks that had one. This section also holds the Utility Agent settings themselves (which agent and model), which used to live in the General tab.
- **An installed model** of the kind the task needs.
- **A model on an enabled endpoint**, for tasks an endpoint can serve (text generation and embeddings).

The readiness line shows a green **Ready**, or names what is wrong and offers the fix: **Download** or **Resume** for a missing model, **Enable** for a switched-off endpoint, or **Check again** when a server did not answer. Some fixes are outside Maestro (for example, starting Ollama), and the line tells you what to do.

### The tasks

| Task                    | Needs                              | Default       | What it does                                                                                                            |
| ----------------------- | ---------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tab naming              | Text generation                    | Utility Agent | Names a new AI tab from the first message sent in it.                                                                   |
| Summaries               | Text generation                    | Utility Agent | Writes context summaries for Summarize & Continue and the group chat participant summary.                               |
| AI command mode         | Text generation                    | Utility Agent | Turns a plain-English request in command mode into a shell command. You review it before it runs.                       |
| Tab cleanup suggestions | Text generation                    | Off           | Suggests tabs to close, snooze, or bring back. Every action still needs your confirmation.                              |
| Git drafts              | Text generation                    | Off           | Drafts a pull request title and description from the branch commits and changed files. Fills the fields, never submits. |
| Semantic search         | Embeddings                         | Off           | Finds history, transcripts, and documents by meaning rather than exact words.                                           |
| Cue gate                | Text generation                    | Off           | Checks a Cue subscription's gate condition against the event before an agent starts.                                    |
| Prompt-injection screen | Classifier                         | Off           | Scores untrusted text for prompt injection before Cue passes it to an agent.                                            |
| Secret screen           | Classifier                         | Off           | Adds model coverage when scanning content for secrets before it is published. Pattern detection always runs.            |
| Dictation               | Speech-to-text                     | Off           | Transcribes speech into any text box without starting a voice session.                                                  |
| Spoken notices          | Text generation and text-to-speech | Off           | Writes a one-line summary to speak aloud when an agent finishes a turn.                                                 |
| Voice routing           | Text generation                    | Off           | Decides which agent and tab a spoken request is for. Off keeps the voice brain chosen in A Cappella settings.           |
| Token proxy             | Text generation                    | Off           | Summarizes large tool output for the token-conservation proxy.                                                          |

For AI command mode, **Utility Agent** means the tab's own provider at its current model and effort. On a local model or an endpoint, the [AI Command Mode](./general-usage#ai-command-mode) strip names that model, and the proposed command comes with one line that says what it does.

**Git drafts** adds a **Draft with local model** button to the Create Pull Request form once it is assigned a source. It reads the branch's commit subjects and the list of changed files (not the diff itself), and fills the title and description for you to edit. It never creates the pull request: that is still the Create PR button. While the task is off the button is not shown, and when the assigned model or endpoint is not ready the button is disabled with the reason beside it.

**Tab cleanup suggestions** opens from the menu at the top of the Left Bar (**Tab Cleanup**) or the command palette (**Tab Cleanup Suggestions**) once it is assigned a source. It gives the model one line about each open and snoozed tab across every agent (its name, when it was last active, how many messages it holds, and what was last asked in it) and lists the tabs the model would close, snooze, or bring back from snooze, each with a one-line reason. It is a list of suggestions and nothing else: every row starts unticked, and no tab changes until you tick the rows you agree with and press **Apply**. A tab that is busy, starred, or holding an unsent draft is never suggested, whatever the model says, and a tab that becomes busy while the list is open is greyed out. A closed tab can still be brought back with Reopen Closed Tab. Snoozed tabs in one batch share the wake time you pick beside the Apply button.

**Semantic search** builds its index in the background once it is assigned a source. It reads History entries, Director's Notes, and the tab transcripts Maestro keeps, and it waits whenever another task is using the model. The **Semantic index** card under Assignments shows how much is indexed. Cue runs are most of History and mostly repeat, so they are left out unless you turn on **Index Cue runs** there. Setting the task back to Off stops indexing.

Once the task is ready, two search boxes gain a **Semantic** toggle (a sparkle icon): the [History panel's filter](./history#by-meaning) and [Search Messages (All Agent Tabs)](./general-usage#searching-message-history). With it on, you describe what you are looking for and each result shows how close it is (a percentage) and the passage that matched. The toggle is not shown while the task is off or its model is not ready. From the command line, `maestro-cli search "<query>" --semantic` runs the same search across every agent.

**A task never falls back.** If a task's assignment is not ready, the task does not run on some other source instead. It reports why, and the readiness line shows the same reason. A silent fallback would send your text somewhere you did not choose.

### The secret screen

Maestro checks content for credentials before it publishes that content for you. Three actions are checked: **Publish as GitHub Gist**, **Send Feedback** (the issue text, a comment on an existing issue, and the support package if you attach one), and **Create Debug Package**.

The check looks for known token shapes (AWS access keys, GitHub tokens, Anthropic and OpenAI keys, Slack tokens, private key blocks), for `api_key = <random value>` style assignments, and for the values of the secret-named environment variables you have set in Maestro. This part needs no model and is always on.

When it finds something, nothing is sent. A dialog lists what it found, with each value masked, and offers **Publish anyway** or **Cancel**. From the command line there is no dialog: the command stops, prints the masked list, and exits with an error. Pass `--allow-secrets` to send the content as it is.

The **Secret screen** task adds a model pass on top of the pattern check. It is off by default. If you assign it a classifier, the content is also scored by that model, and a flag from the model is listed with the model's name and score. A model that cannot run does not block publishing and does not hide a pattern finding: the dialog says that only patterns ran. The catalog's classifiers are trained to detect prompt injection, not credentials, so treat a model flag as a reason to look, not as proof.

The check is a safety net. It does not find every secret, and a clean result is not a guarantee. Read what you publish.

## Privacy

A downloaded model runs inside Maestro, so the text it reads never leaves your machine. An endpoint at a loopback address (`127.0.0.1`, `localhost`, `::1`) is also on your machine.

An endpoint at any other address is a network service. Text sent to it leaves this machine, the same as text sent to an agent's provider. Point a task at a remote endpoint only if you would send that text there yourself.

## Disk and memory

Models install under `models` inside Maestro's user data directory. The Models section shows the total, and removing a model gives the space back.

The models also need an engine to run. ONNX Runtime runs the embedding, classifier, speech, and wake word models. It is about 100 MB, it is not bundled in the installer, and it is downloaded from a pinned release checked against a hash recorded in the app. [Voice Setup](./voice-mode#downloading-the-models) downloads it together with the speech models.

A model uses memory only while it works. It loads the first time a task needs it and unloads after five minutes without use. While loaded, a model uses about as much memory as its size on disk: tens of megabytes for BGE Small and Prompt Guard, several hundred for Parakeet or DeBERTa. An endpoint uses the memory of the server you run, not Maestro's.

## Licenses

Each model arrives under its own license, shown on its row with a link to the full text. Read it before you download. Three are worth knowing:

- **BGE Small** is MIT: use it for anything.
- **EmbeddingGemma** is under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms), which include a prohibited-use policy.
- **Llama Prompt Guard 2** is under the [Llama 4 Community License](https://www.llama.com/llama4/license/), which has its own use policy and attribution terms. DeBERTa v3 Prompt Injection v2 is the Apache-2.0 alternative for the same job, at a much larger download.

The "Hey Jarvis" wake phrase is CC-BY-NC-SA-4.0, which does not allow commercial use.

## From the command line

Everything in the tab has a `maestro-cli models` verb, so an agent can set this up for you. Verbs that touch downloads or servers need the desktop app running; `assign` and `endpoints add` / `remove` work with it closed.

```bash
maestro-cli models list [--kind <kind>]          # catalog by kind, with status and what uses each model
maestro-cli models install <model-id>            # download and verify; waits until done
maestro-cli models verify <model-id>             # re-hash; never deletes or re-downloads
maestro-cli models remove <model-id> [--force]   # refuses a model a task uses, unless --force

maestro-cli models endpoints list
maestro-cli models endpoints detect              # probe for Ollama and LM Studio; adds nothing
maestro-cli models endpoints add --kind ollama [--url <url>] [--name <name>] [--api-key-env <VAR>]
maestro-cli models endpoints test <endpoint> [--model <model>]
maestro-cli models endpoints remove <endpoint>

maestro-cli models tasks                         # every task, its assignment, and readiness
maestro-cli models assign <task-id> off
maestro-cli models assign <task-id> utility-agent
maestro-cli models assign <task-id> local:<model-id>
maestro-cli models assign <task-id> endpoint:<endpoint>:<model>
maestro-cli models status [task-id]              # would it run, and if not, why and what to do
maestro-cli models index                         # the semantic index: state, and how much is indexed
maestro-cli search "<query>" --semantic          # find past work by meaning (drop --semantic for exact text)
maestro-cli models run <task-id> --input "..."   # run a text-generation task once
maestro-cli models run git-drafts --cwd <repo> [--base <branch>]   # draft a pull request title and body
maestro-cli tab suggest-cleanup                  # tabs to close, snooze, or wake; prints them, changes nothing
```

An endpoint can be named by its id, an id prefix, or its name. Every verb takes `--json`. See the [CLI reference](./cli-reference#maestro-cli-models) for every option.
