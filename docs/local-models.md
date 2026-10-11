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
	One entry is listed but not usable yet: **Kokoro 82M** needs a phoneme front end that is not part
	of this build. Its row says so, and replies use your computer's own voice.
</Warning>

### The text model

**Qwen3 1.7B** is the one text model Maestro runs itself. It is small and fast (a tab name in about a quarter of a second on Apple Silicon), and that size decides what it is offered for:

- **Offered for:** tab naming, summaries, the Cue gate, pull request drafts, spoken notices, tab cleanup suggestions, and the token proxy's digest.
- **Not offered for AI command mode.** In testing it wrote a wrong command for one request, and a command that kills a process for a request to find it.
- **Not offered for voice routing.** It sent requests that named an agent to the Conductor instead of to that agent.

The Assignments picker leaves it out of those two tasks. For them, use an [endpoint](#endpoints) with a larger model. `maestro-cli models assign` still accepts it there and prints the reason.

### Engines

A model is a file of weights. An **engine** is the library that reads it: ONNX Runtime for the speech, embedding, classifier, and wake word models, and llama.cpp for the text model. Engines are not bundled in the installer. A model's **Download** button fetches its engine with it when that is missing, and says so on the button ("Download (1.1 GB + 41 MB engine)").

The **Engines** card above the catalog shows each engine on its own: installed, not installed, needs update (a newer build expects a newer engine), or not available on this platform. Press **Install** or **Update** there if an engine did not arrive with its model.

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
| Spoken notices          | Text generation and text-to-speech | Off           | Writes the short summary a spoken notice adds when an agent finishes a turn. See [Spoken notices](#spoken-notices).     |
| Voice routing           | Text generation                    | Off           | Decides which agent and tab a spoken request is for. See [Voice routing](#voice-routing).                               |
| Token proxy             | Text generation                    | Off           | Summarizes large tool output for the token-conservation proxy.                                                          |

For AI command mode, **Utility Agent** means the tab's own provider at its current model and effort. On a local model or an endpoint, the [AI Command Mode](./general-usage#ai-command-mode) strip names that model, and the proposed command comes with one line that says what it does.

**Git drafts** adds a **Draft with local model** button to the Create Pull Request form once it is assigned a source. It reads the branch's commit subjects and the list of changed files (not the diff itself), and fills the title and description for you to edit. It never creates the pull request: that is still the Create PR button. While the task is off the button is not shown, and when the assigned model or endpoint is not ready the button is disabled with the reason beside it.

**Tab cleanup suggestions** opens from the menu at the top of the Left Bar (**Tab Cleanup**) or the command palette (**Tab Cleanup Suggestions**) once it is assigned a source. It gives the model one line about each open and snoozed tab across every agent (its name, when it was last active, how many messages it holds, and what was last asked in it) and lists the tabs the model would close, snooze, or bring back from snooze, each with a one-line reason. It is a list of suggestions and nothing else: every row starts unticked, and no tab changes until you tick the rows you agree with and press **Apply**. A tab that is busy, starred, or holding an unsent draft is never suggested, whatever the model says, and a tab that becomes busy while the list is open is greyed out. A closed tab can still be brought back with Reopen Closed Tab. Snoozed tabs in one batch share the wake time you pick beside the Apply button.

**Semantic search** builds its index in the background once it is assigned a source. It reads History entries, Director's Notes, and the tab transcripts Maestro keeps, and it waits whenever another task is using the model. The **Semantic index** card under Assignments shows how much is indexed. Cue runs are most of History and mostly repeat, so they are left out unless you turn on **Index Cue runs** there. Setting the task back to Off stops indexing.

Once the task is ready, two search boxes gain a **Semantic** toggle (a sparkle icon): the [History panel's filter](./history#by-meaning) and [Search Messages (All Agent Tabs)](./general-usage#searching-message-history). With it on, you describe what you are looking for and each result shows how close it is (a percentage) and the passage that matched. The toggle is not shown while the task is off or its model is not ready. From the command line, `maestro-cli search "<query>" --semantic` runs the same search across every agent.

**A task never falls back.** If a task's assignment is not ready, the task does not run on some other source instead. It reports why, and the readiness line shows the same reason. A silent fallback would send your text somewhere you did not choose.

### Dictation

Dictation types what you say into a text box. It is off until you assign the **Dictation** task a speech-to-text model (a local model such as Parakeet, or an endpoint that offers `/v1/audio/transcriptions`).

Once the task is ready, a small microphone appears in the AI composer, the group chat composer, the file editor, and the Auto Run editor. There are two ways to use it:

- **Tap** the microphone to start, speak, and tap it again to stop.
- **Hold** the microphone down while you speak, and release it when you are done.

The words land where the caret is, replacing any selected text. A pill at the bottom of the window shows that a microphone is recording, with **Stop** and a button that discards the recording.

You can also dictate from the keyboard. Open **Settings**, then **Shortcuts**, and give **Dictate into Text Box** a chord (it ships with none). The chord works the same way, tap or hold, and it dictates into whichever text box holds the caret, including text boxes that have no microphone button of their own.

Dictation is not a voice session. Nothing is sent to an agent, nothing is spoken back, and the text is not submitted for you: it is typed into the box and you send it when you are ready. In the AI composer, dictated text never changes the command mode, so a sentence cannot become a shell command by accident.

If the microphone is dimmed, its tooltip says why (the model is not downloaded, the endpoint is not reachable) and what to do. Dictation does not run on a different source instead. The first time you dictate, your operating system asks for microphone access; if access is denied, Maestro says so and offers to open the system setting. A recording stops by itself after 5 minutes and keeps what it captured. Dictation is not available from the web interface, because the microphone is on the computer that runs Maestro. It also cannot start while an A Cappella voice session is open, since speech is already going to that session.

### Spoken notices

A spoken notice is one line said aloud when an agent finishes a turn. You turn notices on in **Settings**, then **Notifications**, under **Speak When an Agent Finishes**: only when Maestro is not focused, or always. They are off by default.

The **Spoken notices** task decides how much the line says:

- **Off** (the default): the line is the agent's name and "finished", for example "Backend finished". This needs no model.
- **A local model or an endpoint**: the model reads the end of the agent's reply and adds a short summary, for example "Backend finished: tests pass, two files changed".

If the assigned model is not ready, or takes longer than 20 seconds, the plain line is spoken instead and Maestro tells you once why. A notice is never skipped because of the model.

The line is spoken with a local voice on the computer that runs Maestro. It uses the voice, speed, and volume you chose for A Cappella when that voice is a local one, and your computer's own voice otherwise. A hosted voice is never used for a notice, because a notice is spoken without you asking and would send text to that service each time.

Notices never overlap. One line is spoken at a time, the next waits a few seconds after it, and a line that has waited a minute is dropped as old news. Nothing is spoken while an A Cappella voice session is open, and a notice waits while you dictate.

From the command line, `maestro-cli notify speak "<text>"` says a line of your own through the same voice and the same queue, and reports whether it was spoken.

### Voice routing

**Voice routing** is the Conductor Brain of [A Cappella](./voice-mode): the model that decides which agent and tab a spoken request is for. Assign it a model on one of your [endpoints](#endpoints) and that model routes. It is the same choice as the **Conductor Brain** picker in **Settings > Plugins > A Cappella > Voice Providers**: picking an endpoint model there assigns it here, and an assignment made here shows there. There is one setting, not two.

**Off** (the default) means the Brain is the one chosen in A Cappella: the built-in keyword router, or a hosted model. Picking one of those in the Conductor Brain picker sets this task back to Off.

Your transcripts are sent to the endpoint you assign, and the line at the top of Voice Providers names it ("Audio stays on this machine. Text is sent to Ollama."). Audio is not sent there.

If the assigned model cannot answer (the server is down, the model is not loaded), the voice session says so by name and does not route on another Brain. A turn is given 30 seconds, because the first one can include the server loading the model.

<Note>
	A model run on this machine is not offered as a Conductor Brain yet. The one text model in the
	catalog, Qwen3 1.7B, loads and answers quickly, but in testing it sent requests that named an
	agent to the Conductor instead of to that agent. Use an endpoint with a larger model, the
	built-in router, or a hosted Brain.
</Note>

### The secret screen

Maestro checks content for credentials before it publishes that content for you. Three actions are checked: **Publish as GitHub Gist**, **Send Feedback** (the issue text, a comment on an existing issue, and the support package if you attach one), and **Create Debug Package**.

The check looks for known token shapes (AWS access keys, GitHub tokens, Anthropic and OpenAI keys, Slack tokens, private key blocks), for `api_key = <random value>` style assignments, and for the values of the secret-named environment variables you have set in Maestro. This part needs no model and is always on.

When it finds something, nothing is sent. A dialog lists what it found, with each value masked, and offers **Publish anyway** or **Cancel**. From the command line there is no dialog: the command stops, prints the masked list, and exits with an error. Pass `--allow-secrets` to send the content as it is.

The **Secret screen** task adds a model pass on top of the pattern check. It is off by default. If you assign it a classifier, the content is also scored by that model, and a flag from the model is listed with the model's name and score. A model that cannot run does not block publishing and does not hide a pattern finding: the dialog says that only patterns ran. The catalog's classifiers are trained to detect prompt injection, not credentials, so treat a model flag as a reason to look, not as proof.

The check is a safety net. It does not find every secret, and a clean result is not a guarantee. Read what you publish.

## Gateway

A gateway is an HTTP proxy that an agent's requests go through on the way to its provider. People run one to cut the tokens an agent sends ([Headroom](https://github.com/chopratejas/headroom) compresses large tool results), or to route and meter traffic ([LiteLLM](https://github.com/BerriAI/litellm)). The Gateway section lists your agents and lets you give each one a gateway URL. The same field is in each agent's **Edit Agent** dialog.

A gateway is set per agent and is off until you type a URL. When the agent next starts, Maestro points the provider's CLI at that URL:

| Provider    | How it is pointed at the gateway                                           |
| ----------- | -------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_BASE_URL`                                                       |
| Codex       | `OPENAI_BASE_URL`, and the argument `-c openai_base_url="<url>"`           |
| Copilot CLI | Nothing. Copilot CLI ignores base-URL variables, so the field is disabled. |
| OpenCode    | Nothing. It sets a base URL per model provider in its own config file.     |
| Others      | Nothing known to Maestro. The field is disabled and says so.               |

Codex gets both because Codex CLI does not read `OPENAI_BASE_URL` on a ChatGPT login (tested with 0.162.1); the argument is what it honors.

Four rules:

- **Your own variable wins.** If the agent's environment variables already set the base-URL variable, Maestro leaves your value alone and the gateway is not applied. The field says so. The gateway does win over a value set for every agent in Settings -> Environment, because a gateway on one agent is the more specific choice.
- **A gateway that cannot be used stops the agent.** The agent does not start, and the message names the gateway. Maestro never sends the turn to a different endpoint than the one you chose. If the proxy is not running, the agent's own connection error is what you see.
- **A loopback gateway does not work for an SSH remote agent.** `http://127.0.0.1:8787` on this machine is a different machine from the remote host's point of view, so the agent is refused at launch. Give it a URL the remote host can reach.
- **It covers the agent's own turns.** Chat, Auto Run, Cue runs, and `maestro-cli send` go through the gateway. Housekeeping that Maestro runs for an agent (tab naming, context grooming, a Group Chat turn) does not.

Each row with a gateway has **Show environment**, which lists the agent's effective environment variables and where each came from. The base-URL variable is marked **Local Models gateway**, or marked with the layer that beat it.

An agent on a subscription login (Claude or Codex) saves quota, not dollars. Sending its traffic through a proxy is your choice for each agent, and you are responsible for your provider's terms.

From the command line:

```bash
maestro-cli update-agent <agent-id> --gateway-url http://127.0.0.1:8787
maestro-cli update-agent <agent-id> --gateway-url none
maestro-cli show agent <agent-id> --json   # gatewayUrl
```

### The Maestro proxy

Maestro has a proxy of its own, so you do not need to run one to save tokens. Each row of the Gateway table has a **Maestro proxy** control with three modes:

| Mode            | What happens to the agent's requests                                                                |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Off**         | They do not go through Maestro's proxy. This is the default.                                        |
| **Passthrough** | They go through it unchanged. Maestro only counts them.                                             |
| **Compress**    | Large tool results (file reads, command output) in each request are shortened before it is sent on. |

Choosing Passthrough or Compress sets the agent's gateway URL to the proxy for you. Choosing Off clears it. The proxy listens on `127.0.0.1` only, starts when the first agent uses it, and stops when none do.

What Compress does, and does not do:

- **It shortens only tool results**, and only ones over about 1,000 tokens. Your messages, the system prompt, tool definitions, and the agent's own text are never changed.
- **The model reads every tool result in full once.** A result is shortened from the next request on, when it is history.
- **The same text always shortens to the same bytes.** Each result is keyed by a SHA-256 hash of its content and the first result is kept, so your provider's prompt cache keeps working.
- **Every change is marked and kept.** A shortened block ends with `[maestro-compressed sha256=... original_tokens=...]`, and the original stays on this machine.
- **If shortening fails, the request is sent as it arrived.** You do not lose a turn to it.
- **A local model is optional.** Rules do most of the work (minified JSON, repeated log lines folded, long lines cut). Assign the **Token proxy** task a model in Assignments to also summarize results that are still very large.

Under the table, **Maestro token proxy** shows what it did in the last 30 days, in all and per agent: requests, tokens saved, and the average time a request was held to be shortened. **Recent compressions** lists the blocks it last shortened. Select one to see a diff of what the agent sent against what was sent in its place.

The proxy cannot be used by an agent on an SSH remote (the remote host cannot reach this machine's `127.0.0.1`) or by a provider with no base-URL variable. The control is disabled for those and says why. A turn started with `maestro-cli send` goes through the proxy unchanged and is counted without an agent name, because only the app tells the proxy which agent a request belongs to.

```bash
maestro-cli update-agent <agent-id> --proxy-mode compress   # off | passthrough | compress
maestro-cli show agent <agent-id> --json                    # tokenProxyMode
maestro-cli models proxy status                             # the listener, agents, totals, recent compressions
maestro-cli models proxy block <hash>                       # a diff of one shortened block
```

## Privacy

A downloaded model runs inside Maestro, so the text it reads never leaves your machine. An endpoint at a loopback address (`127.0.0.1`, `localhost`, `::1`) is also on your machine.

An endpoint at any other address is a network service. Text sent to it leaves this machine, the same as text sent to an agent's provider. Point a task at a remote endpoint only if you would send that text there yourself.

## Disk and memory

Models install under `models` inside Maestro's user data directory. The Models section shows the total, and removing a model gives the space back.

The models also need an [engine](#engines) to run. ONNX Runtime (about 100 MB) runs the embedding, classifier, speech, and wake word models, and llama.cpp (about 41 MB) runs the text model. Neither is bundled in the installer. Each is downloaded from a pinned release and checked against a hash recorded in the app, either with the first model that needs it or from the Engines card. [Voice Setup](./voice-mode#downloading-the-models) downloads ONNX Runtime together with the speech models.

A model uses memory only while it works. It loads the first time a task needs it and unloads after five minutes without use. While loaded, a model uses about as much memory as its size on disk: tens of megabytes for BGE Small and Prompt Guard, several hundred for Parakeet or DeBERTa, and about 1.5 GB for Qwen3 1.7B. An endpoint uses the memory of the server you run, not Maestro's.

## Licenses

Each model arrives under its own license, shown on its row with a link to the full text. Read it before you download. Three are worth knowing:

- **BGE Small** is MIT: use it for anything.
- **EmbeddingGemma** is under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms), which include a prohibited-use policy.
- **Llama Prompt Guard 2** is under the [Llama 4 Community License](https://www.llama.com/llama4/license/), which has its own use policy and attribution terms. DeBERTa v3 Prompt Injection v2 is the Apache-2.0 alternative for the same job, at a much larger download.

The "Hey Jarvis" wake phrase is CC-BY-NC-SA-4.0, which does not allow commercial use.

## From the command line

Everything in the tab has a `maestro-cli models` verb, so an agent can set this up for you. Verbs that touch downloads or servers need the desktop app running; `assign` and `endpoints add` / `update` / `remove` work with it closed.

```bash
maestro-cli models list [--kind <kind>]          # catalog by kind, with status and what uses each model
maestro-cli models install <model-id>            # download and verify, with its engine; waits until done; resumes a paused download
maestro-cli models pause <model-id>              # stop a running download, keep what arrived
maestro-cli models cancel <model-id>             # stop a download and delete its partial files
maestro-cli models verify <model-id>             # re-hash; never deletes or re-downloads
maestro-cli models remove <model-id> [--force]   # refuses a model a task uses, unless --force
maestro-cli models runtimes list                 # the engines: state, size, and the models each runs
maestro-cli models runtimes install <onnx|llama> # install or update one engine on its own

maestro-cli models endpoints list
maestro-cli models endpoints detect              # probe for Ollama and LM Studio; adds nothing
maestro-cli models endpoints add --kind ollama [--url <url>] [--name <name>] [--api-key-env <VAR>]
maestro-cli models endpoints update <endpoint> [--name <name>] [--url <url>] [--kind <kind>] [--api-key-env <VAR> | --clear-api-key-env] [--enable | --disable]
maestro-cli models endpoints models <endpoint>   # the models the server lists now, for `assign endpoint:...`
maestro-cli models endpoints test <endpoint> [--model <model>]
maestro-cli models endpoints remove <endpoint>

maestro-cli models tasks                         # every task, its assignment, and readiness
maestro-cli models assign <task-id> off
maestro-cli models assign <task-id> utility-agent
maestro-cli models assign <task-id> local:<model-id>
maestro-cli models assign <task-id> endpoint:<endpoint>:<model>
maestro-cli models status [task-id]              # would it run, and if not, why and what to do
maestro-cli models index                         # the semantic index: state, and how much is indexed
maestro-cli models proxy status                  # the Maestro token proxy: agents, tokens saved, added latency
maestro-cli search "<query>" --semantic          # find past work by meaning (drop --semantic for exact text)
maestro-cli models run <task-id> --input "..."   # run a text-generation task once
maestro-cli models run git-drafts --cwd <repo> [--base <branch>]   # draft a pull request title and body
maestro-cli models run dictation --audio <file.wav>   # transcribe a 16-bit PCM WAV file with the Dictation model
maestro-cli tab suggest-cleanup                  # tabs to close, snooze, or wake; prints them, changes nothing
maestro-cli notify speak "<text>"                # say one line aloud with the spoken-notices voice; waits until heard
```

An endpoint can be named by its id, an id prefix, or its name. Every verb takes `--json`. See the [CLI reference](./cli-reference#maestro-cli-models) for every option.
