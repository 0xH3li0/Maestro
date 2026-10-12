---
title: Local Models
description: Run Maestro's housekeeping tasks on models that live on your machine or on a model server you already run, instead of spending agent turns on them.
icon: hard-drive
---

Maestro does a lot of small model work besides your agents' own turns: it names new tabs, writes context summaries, turns a plain-English request into a shell command, and more. By default most of that runs through the **Utility Agent**, an ordinary agent spawn. **Local Models** lets you point each of those jobs somewhere else: a small model Maestro downloads and runs itself, or a model server you already run, such as Ollama or LM Studio. A model on one of those can also be the model behind one of your agents: see [Run on](#run-on).

Open it from **Settings -> Models**, or run **Open Models Settings** from the command palette. From a terminal, `maestro-cli open settings --tab models` opens it, and `--sub-tab system-one` (or `library`, `sources`, `system-two`, `gateway`) lands on one of its inner tabs. The old name still works: `--tab local-models` opens the same tab. It is a core part of Maestro, not an Encore Feature, and it starts empty.

<Note>
	**Nothing downloads on its own.** Opening the tab, or enabling anything else in Maestro, fetches
	no model and calls no server. Every download, every server probe, and every test is a button you
	press. Every task also starts where it was: the ones that already ran through the Utility Agent stay
	there, and every new task starts **Off**.
</Note>

The tab has five inner tabs. Maestro remembers the one you used last.

| Inner tab      | What lives there                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**    | The [models](#models) Maestro downloads, the [engines](#engines) that run them, and the disk they use.                                              |
| **Sources**    | Where models come from besides the Library: the [endpoints](#endpoints) (Ollama, LM Studio, any OpenAI-compatible server) you have added.           |
| **System One** | The tasks whose answer is a judgment: a decision, label, score, vector, or transcript. See [System One and System Two](#system-one-and-system-two). |
| **System Two** | The tasks that write text for someone to read or run, plus the Utility Agent settings.                                                              |
| **Gateway**    | Per-agent gateway URLs, the token proxy mode for each agent, and what the token proxy carried and saved. See [Gateway](#gateway).                   |

### System One and System Two

One rule sorts every task. If its output is a **judgment** (a decision, label, score, vector, or transcript), it is **System One**: fast, small, and cheap to run often. If its output is **text written for someone to read or run**, it is **System Two**.

| System One                                                                                                           | System Two                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Cue gate, Prompt-injection screen, Secret screen, Voice routing, Tab cleanup suggestions, Semantic search, Dictation | Tab naming, Summaries, AI command mode, Git drafts, Spoken notices, Token proxy |

A task's assignment row sits on the inner tab of its system. Every message in Maestro that says where to pick a model for a task names that inner tab, for example "Settings > Models > System One".

## Models

Models are files Maestro downloads, checks, and runs on this machine. They live in **Models -> Library**. The top of the tab shows how much disk the installed models use, how many are installed, and how many need attention. It also names what this computer has to run a model on, for example "32.0 GB of unified memory (Apple Silicon)" or "32.0 GB of RAM, NVIDIA GeForce RTX 4060 (8.0 GB)".

Below that is the Library, grouped by what each model is for. A text model is listed once, under its most specific role, and its other roles are badges on its row:

| Group          | Model                             | Size     | Good at                                                                   |
| -------------- | --------------------------------- | -------- | ------------------------------------------------------------------------- |
| Runs agents    | Gemma 4 E4B (Q4_0)                | 5.2 GB   | Screenshots and images, many languages, fast replies on laptops           |
| Runs agents    | gpt-oss 20B (MXFP4)               | 11.3 GB  | Reasoning with tool calls; the smallest that drives Claude Code and Codex |
| Runs agents    | Qwen3-Coder 30B-A3B (Q4_K_M)      | 17.3 GB  | A fast coding agent with tool use                                         |
| Runs agents    | Gemma 4 31B (Q4_K_M)              | 18.2 GB  | The strongest Gemma: tool calling and images                              |
| Runs agents    | Qwen3-Coder-Next 80B-A3B (Q4_K_M) | 45.2 GB  | The strongest local coding agent                                          |
| Runs agents    | gpt-oss 120B (MXFP4)              | 59.0 GB  | The strongest local reasoning and tool use                                |
| Housekeeping   | Qwen3.5 9B (Q4_K_M)               | 5.3 GB   | Commit and PR drafts, shell commands and summaries                        |
| Housekeeping   | Devstral Small 2 24B (Q4_K_M)     | 13.3 GB  | Multi-file edits in large repositories                                    |
| Housekeeping   | Qwen3.6 35B-A3B (Q4_K_M)          | 19.0 GB  | General agent work: fast, with a long context                             |
| Housekeeping   | Qwen3.8 27B (Q4_K_M)              | 17.7 GB  | Hard reasoning and coding                                                 |
| Judge          | Qwen3 1.7B Instruct (Q4_K_M)      | 1.0 GB   | The fastest small judgments: tab names, gate answers, short summaries     |
| Judge          | Qwen3.5 4B (Q4_K_M)               | 2.6 GB   | Every housekeeping task, shell commands and voice routing included        |
| Vision         | Gemma 4 12B (Q4_K_M)              | 6.8 GB   | Writing and multilingual work, with images                                |
| Embeddings     | BGE Small (English)               | 33.1 MB  | Quick search by meaning in English                                        |
| Embeddings     | EmbeddingGemma 300M               | 208.6 MB | Higher-quality search by meaning, in many languages                       |
| Classifiers    | Llama Prompt Guard 2 22M          | 77.4 MB  | Catching prompt injection in untrusted text                               |
| Classifiers    | DeBERTa v3 Prompt Injection v2    | 712.6 MB | The same, under a permissive license, at a larger size                    |
| Speech-to-text | Parakeet TDT 0.6B (English)       | 630.7 MB | Dictated English: names, casing and punctuation                           |
| Speech-to-text | Whisper Base (English)            | 198.8 MB | Plain English dictation on modest hardware                                |
| Text-to-speech | Kokoro 82M                        | 311.0 MB | Reading replies and notices aloud                                         |
| Wake word      | openWakeWord Base                 | 2.3 MB   | Hearing the wake and stop words with little CPU                           |
| Wake word      | Wake phrase: "Hey Jarvis"         | 1.2 MB   | Hearing "hey jarvis" to start a hands-free session                        |

The text models are all Apache-2.0. The licenses of the others are under [Licenses](#licenses).

**Runs agents** is not a claim from a model card. A model is in that group only after it fixed a bug in a scratch repository through a real harness, and its badge names the harnesses it passed with ("Runs agents: Claude Code, Codex").

Each row shows what the model is good at, its size, its license, and what uses it right now: the tasks assigned to it, and the A Cappella voice slot when voice can use it. Each row has **Download**, **Pause**, **Cancel**, **Re-verify**, and **Remove**.

Every file comes from a pinned revision and is checked against a SHA-256 recorded in the app, so a file altered in transit fails to install rather than running. **Re-verify** hashes the files again and never deletes or re-downloads anything.

**Removing a model a task uses warns first.** The warning names the tasks that would stop working, and you choose **Remove anyway** or **Keep it**.

### Will it run on this computer

Each row carries a fit label, judged against this computer and the context the model runs at:

| Label         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| **Fits**      | The model and its context fit in the memory the GPU can use   |
| **Tight**     | It runs, slowly or with the system squeezed. The row says why |
| **Too large** | It does not run here. The row says how much it needs          |

A model needs its file, plus memory for its context, plus room for the system. The rule depends on the machine:

- **Apple Silicon.** The GPU can use about 75% of memory by default. A model fits when its file, its context and 2 GB for the system are within that. It is tight up to 90%.
- **A PC with a graphics card.** A model fits when its file and its context are within the card's memory. A mixture-of-experts model that does not fit can keep part of itself in RAM, and is tight. A dense model that does not fit is too large.
- **No GPU.** A model is never better than tight, and only models under 10B active parameters are offered.

As examples, on a Mac: Qwen3.5 4B fits in 8 GB; Gemma 4 E4B, Qwen3.5 9B and Gemma 4 12B fit in 16 GB; the 20B to 35B models fit in 32 GB; Qwen3-Coder-Next is tight in 64 GB, and it and gpt-oss 120B fit in 128 GB.

Models that are too large are hidden. **Show models too large for this machine** at the bottom of the list shows them. A model with files on disk is never hidden.

On a PC, Maestro reads the graphics card's memory from the model server's engine. Until that engine is installed, the Library says so and judges each model as if it ran on the CPU. Install the engine under [Model server](#model-server) for an accurate answer.

### Cloud only

DeepSeek V4, Kimi K3, Kimi K2.7 Code and GLM-5.3 are too large to run on a desktop (the smallest is 155 GB), so the Library does not offer them. Use them through their provider's API, with your own key, from **Sources**.

### Add from Hugging Face

**Add from Hugging Face**, below the list, adds a GGUF text model the Library does not offer. Enter the repo id (`unsloth/Qwen3.5-2B-GGUF`) and the file name (`Qwen3.5-2B-Q4_K_M.gguf`), then:

1. **Look up** asks Hugging Face about the repo and shows the model's license (from its model card), its size, and its fit. Nothing is saved or downloaded yet.
2. **Add to Library** saves the model. It appears in the **Added from Hugging Face** group with its own **Download** button.

A model you add is labeled **Not verified by Maestro**. Maestro pins the revision the repo was at when you added it, and checks the download against the hash Hugging Face reports for that revision, so a damaged download still fails to install. Nobody at Maestro has tested the model, so it has no role and no "good at" line, and its fit is an estimate from its size.

- Naming one part of a split GGUF (`-00001-of-00003.gguf`) adds every part.
- A gated or private repo cannot be added: Maestro downloads without an account.
- **Remove from Library** on the row deletes the model's files and takes it out of the list. **Remove** deletes only the files.

### Download source

Models download from Hugging Face. If your network blocks it, set a mirror under **Models > Library > Advanced > Download source**: a base URL that serves the same paths as Hugging Face (`/<repo>/resolve/<revision>/<file>` and `/api/models/<repo>`). Downloads and **Add from Hugging Face** then request from the mirror. **Use Hugging Face** puts the default back.

The mirror changes the host and nothing else. Every file is still checked against the hash Maestro pins (or, for a model you added, the hash Hugging Face reported), so a mirror that serves different bytes fails the download. Only `http` and `https` URLs with a host are accepted, and credentials in the URL are refused. A change applies to the next request, so a download already running keeps its host; pause and resume it to move it to the new one.

### The small text models

Two small models do the housekeeping tasks. Both were run on the same requests, on the prompts Maestro ships:

| Task                                 | Qwen3.5 4B (2.6 GB)          | Qwen3 1.7B (1.0 GB)               |
| ------------------------------------ | ---------------------------- | --------------------------------- |
| Tab names (8)                        | 8 good, both ID numbers kept | 8 good, one ID number dropped     |
| Shell commands (8)                   | 8 correct                    | 1 correct, 1 that kills a process |
| Cue gate answers (8)                 | 8 correct                    | 8 correct                         |
| Pull request drafts (2)              | 2 good, with file names      | 2 good, shorter                   |
| Spoken requests sent to an agent (4) | 4                            | 0                                 |
| A tab name on Apple Silicon          | about 0.25 s                 | about 0.1 s                       |

**Qwen3.5 4B is the one to start with.** It is offered for every text task, and it fits a Mac with 8 GB of memory.

**Qwen3 1.7B** is the smallest and the fastest, and that size decides what it is offered for:

- **Offered for:** tab naming, summaries, the Cue gate, pull request drafts, spoken notices, tab cleanup suggestions, and the token proxy's digest.
- **Not offered for AI command mode.** In testing it wrote one correct command for eight requests, and a command that kills a process for a request to find it.
- **Not offered for voice routing.** It sent requests that named an agent to the Conductor instead of to that agent.

The assignment picker leaves it out of those two tasks. For them, use Qwen3.5 4B, or an [endpoint](#endpoints) with a larger model. `maestro-cli models assign` still accepts it there and prints the reason.

### The neural voice

**Kokoro 82M** is a neural text-to-speech voice that runs on this machine: American English, one voice (Heart). It speaks about six times faster than real time on Apple Silicon. Choose it under **Text-to-Speech** in the A Cappella voice settings, and it is also the voice [spoken notices](#spoken-notices) use when it is the voice you chose there. The system voice stays the default, because it needs no download.

Kokoro reads text through espeak-ng, which turns words into the sounds the model was trained on. espeak-ng ships inside Maestro (it is small, and plain JavaScript) under the GPL, version 3 or later; see `THIRD-PARTY-NOTICES.md` in the repository.

### Engines

A model is a file of weights. An **engine** is the library that reads it: ONNX Runtime for the speech, embedding, classifier, and wake word models, and llama.cpp for the text model. Engines are not bundled in the installer. A model's **Download** button fetches its engine with it when that is missing, and says so on the button ("Download (1.1 GB + 41 MB engine)").

The **Engines** card above the catalog shows each engine on its own: installed, not installed, needs update (a newer build expects a newer engine), or not available on this platform. Press **Install** or **Update** there if an engine did not arrive with its model.

The speech and wake word models are the same files A Cappella uses. Installing them here or from [Voice Setup](./voice-mode#downloading-the-models) is the same install, and either page shows it.

## Endpoints

An endpoint is a model server you run yourself. Endpoints live in **Models -> Sources**. Maestro sends it requests and downloads nothing. If you already run one, it is the fastest way to a working text model. Three kinds are supported:

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

Assignments choose what each task runs on. There is one row per task, each with a source picker and a readiness line. The rows are on **Models -> System One** and **Models -> System Two**, each tab listing only its own tasks.

The picker only offers sources that can do the job:

- **Off**: the feature does not use a model.
- **Utility Agent**: the task's existing agent path, for tasks that had one. The Utility Agent settings themselves (which agent and model) sit under the table on **System Two**. The General tab keeps only the switch for automatic tab naming, with a link to System Two for the model choice.
- **An installed model** of the kind the task needs.
- **A model on an enabled endpoint**, for tasks an endpoint can serve (text generation and embeddings).

The readiness line shows a green **Ready**, or names what is wrong and offers the fix: **Download** or **Resume** for a missing model, **Enable** for a switched-off endpoint, or **Check again** when a server did not answer. Some fixes are outside Maestro (for example, starting Ollama), and the line tells you what to do.

### The tasks

| Task                    | System | Needs                              | Default       | What it does                                                                                                                    |
| ----------------------- | ------ | ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Tab naming              | Two    | Text generation                    | Utility Agent | Names a new AI tab from the first message sent in it.                                                                           |
| Summaries               | Two    | Text generation                    | Utility Agent | Writes context summaries for Summarize & Continue and the group chat participant summary.                                       |
| AI command mode         | Two    | Text generation                    | Utility Agent | Turns a plain-English request in command mode into a shell command. You review it before it runs.                               |
| Tab cleanup suggestions | One    | Text generation                    | Off           | Suggests tabs to close, snooze, or bring back. Every action still needs your confirmation.                                      |
| Git drafts              | Two    | Text generation                    | Off           | Drafts a pull request title and description from the branch commits and changed files. Fills the fields, never submits.         |
| Semantic search         | One    | Embeddings                         | Off           | Finds history, transcripts, and documents by meaning rather than exact words.                                                   |
| Cue gate                | One    | Text generation                    | Off           | Checks a Cue subscription's gate condition against the event before an agent starts.                                            |
| Prompt-injection screen | One    | Classifier                         | Off           | Scores untrusted text for prompt injection before Cue passes it to an agent.                                                    |
| Secret screen           | One    | Classifier                         | Off           | Adds model coverage when scanning content for secrets before it is published. Pattern detection always runs.                    |
| Dictation               | One    | Speech-to-text                     | Off           | Transcribes speech into any text box without starting a voice session.                                                          |
| Spoken notices          | Two    | Text generation and text-to-speech | Off           | Writes the short summary a spoken notice adds when an agent finishes a turn. See [Spoken notices](#spoken-notices).             |
| Voice routing           | One    | Text generation                    | Off           | Decides which agent and tab a spoken request is for. See [Voice routing](#voice-routing).                                       |
| Token proxy             | Two    | Text generation                    | Off           | Summarizes large tool output for the token-conservation proxy.                                                                  |
| Local judge             | One    | Text generation                    | Off           | The text model the System One local judge answers on: yes or no, pick one, or rate on a rubric. Its answers are not calibrated. |

For AI command mode, **Utility Agent** means the tab's own provider at its current model and effort. On a local model or an endpoint, the [AI Command Mode](./general-usage#ai-command-mode) strip names that model, and the proposed command comes with one line that says what it does.

**Git drafts** adds a **Draft with local model** button to the Create Pull Request form once it is assigned a source. It reads the branch's commit subjects and the list of changed files (not the diff itself), and fills the title and description for you to edit. It never creates the pull request: that is still the Create PR button. While the task is off the button is not shown, and when the assigned model or endpoint is not ready the button is disabled with the reason beside it.

**Tab cleanup suggestions** opens from the menu at the top of the Left Bar (**Tab Cleanup**) or the command palette (**Tab Cleanup Suggestions**) once it is assigned a source. It gives the model one line about each open and snoozed tab across every agent (its name, when it was last active, how many messages it holds, and what was last asked in it) and lists the tabs the model would close, snooze, or bring back from snooze, each with a one-line reason. It is a list of suggestions and nothing else: every row starts unticked, and no tab changes until you tick the rows you agree with and press **Apply**. A tab that is busy, starred, or holding an unsent draft is never suggested, whatever the model says, and a tab that becomes busy while the list is open is greyed out. A closed tab can still be brought back with Reopen Closed Tab. Snoozed tabs in one batch share the wake time you pick beside the Apply button.

**Semantic search** builds its index in the background once it is assigned a source. It reads History entries, Director's Notes, and the tab transcripts Maestro keeps, and it waits whenever another task is using the model. The **Semantic index** card under the Semantic search row on System One shows how much is indexed. Cue runs are most of History and mostly repeat, so they are left out unless you turn on **Index Cue runs** there. Setting the task back to Off stops indexing.

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
	A model run on this machine can be the Conductor Brain too. Qwen3.5 4B is offered for it: in
	testing it sent every request to the agent it named, in about a second a turn. It opens a new
	tab more often than the built-in router where an old tab should be recalled. Qwen3 1.7B is not
	offered: it sent requests that named an agent to the Conductor instead of to that agent.
</Note>

### The secret screen

Maestro checks content for credentials before it publishes that content for you. Three actions are checked: **Publish as GitHub Gist**, **Send Feedback** (the issue text, a comment on an existing issue, and the support package if you attach one), and **Create Debug Package**.

The check looks for known token shapes (AWS access keys, GitHub tokens, Anthropic and OpenAI keys, Slack tokens, private key blocks), for `api_key = <random value>` style assignments, and for the values of the secret-named environment variables you have set in Maestro. This part needs no model and is always on.

When it finds something, nothing is sent. A dialog lists what it found, with each value masked, and offers **Publish anyway** or **Cancel**. From the command line there is no dialog: the command stops, prints the masked list, and exits with an error. Pass `--allow-secrets` to send the content as it is.

The **Secret screen** task adds a model pass on top of the pattern check. It is off by default. If you assign it a classifier, the content is also scored by that model, and a flag from the model is listed with the model's name and score. A model that cannot run does not block publishing and does not hide a pattern finding: the dialog says that only patterns ran. The catalog's classifiers are trained to detect prompt injection, not credentials, so treat a model flag as a reason to look, not as proof.

The check is a safety net. It does not find every secret, and a clean result is not a guarantee. Read what you publish.

## Model server

The Maestro model server shares the models in your Library over HTTP, so an agent harness such as Claude Code, Codex, or OpenCode can use them. It is llama.cpp's own `llama-server`, which Maestro downloads as an [engine](#engines), starts, and watches. It speaks the three protocols a harness uses: OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), and Anthropic Messages (`/v1/messages`). It serves text generation models only.

The card is on **Models -> Library**, below the models. It shows the state, the build in use and its accelerator (**Metal**, **Vulkan (NVIDIA ...)**, or **CPU**), the address, the key, and the models loaded now with the memory their weights take.

- **It never starts on its own.** Press **Start**. It also starts when something you turned on needs it, such as a task you assigned to it. It stops when you press **Stop** and when Maestro quits.
- **Install the engine first.** The card has an **Install** button and a build choice. The default build is Metal on a Mac and Vulkan on Windows and Linux, which runs on any GPU vendor. **Advanced** offers the CPU build, and on Windows and Linux x64 the CUDA and ROCm builds. Those are large downloads and need a matching driver. If the accelerator check finds no GPU, or finds the Vulkan loader missing, the card says so and offers the CPU build. Maestro never swaps a build without telling you.
- **The port is chosen once and kept.** An address you gave a harness keeps working across restarts. If another program holds the port, the start fails and names the address; the server does not move.
- **One model is loaded at a time.** The server loads a model the first time a request names it and unloads the least recently used one when another arrives. A second copy of a 20 GB model is a real cost, so the default is one. **Models loaded at once** raises it.
- **Context is at least 40,960 tokens.** An agent's first prompt is about 14,000 tokens, and a smaller context fails with "Prompt is too long". Maestro sets this for each model.

### Local only or Network

| Mode           | Listens on  | Who can reach it                         |
| -------------- | ----------- | ---------------------------------------- |
| **Local only** | `127.0.0.1` | This machine                             |
| **Network**    | `0.0.0.0`   | Any machine that can reach this computer |

**Both modes require the key.** Local only uses it too, so another program on this machine, or a web page your browser has open, cannot use your models without it. Maestro generates the key, stores it sealed with the operating system's key store, and never writes it to a log. **Copy** puts it on the clipboard and **Rotate** makes a new one (every harness you set up by hand then needs the new key). Network mode refuses to start without a key, and the card warns that anyone on the network who has the key can use the models and the memory they take.

Choose Network only on a network you trust. The key travels in clear text over plain HTTP.

### Point a harness at it by hand

To make one of your agents use the server, set its [Run on](#run-on) target: Maestro then sets the variables and arguments below for you, on every launch. Do it by hand only for a harness that Maestro does not run. Read the address with `maestro-cli models server status` and the key with `maestro-cli models server key`, then use the model's catalog id (for example `qwen3-1.7b-instruct-q4km`) as the model name.

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> \
ANTHROPIC_AUTH_TOKEN=<key> \
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model-id> \
CLAUDE_CODE_MAX_CONTEXT_TOKENS=40960 \
claude --model <model-id>

# Codex (the key is read from the environment variable named by env_key)
MAESTRO_LOCAL_KEY=<key> codex \
  -c 'model_providers.maestro={name="Maestro", base_url="http://127.0.0.1:<port>/v1", env_key="MAESTRO_LOCAL_KEY", wire_api="responses"}' \
  -c 'model_provider="maestro"' exec -m <model-id> "your prompt"
```

Both were tested with Claude Code 2.1.296 and Codex CLI 0.162.1. A small model follows an agent's tools less well than a hosted one, so expect a short turn to work and a long one to wander.

### Using the server for housekeeping tasks

The server is also an endpoint named **Maestro model server**. It is built in: it cannot be edited or removed, and only this card controls it. Pick it in an [assignment](#assignments) to run a task on it. Assigning a task to it starts the server and loads the model when the task runs.

You never pay for a second copy. If the server is running with a model loaded, a task assigned to that same local model goes to the server instead of loading the model inside Maestro.

From the command line:

```bash
maestro-cli models server status [--json]       # state, build, accelerator, address, loaded models
maestro-cli models server start
maestro-cli models server stop
maestro-cli models server set --bind local      # or network; --max-models <n>; --rotate-key; --build default|cpu|cuda|rocm
maestro-cli models server key                   # prints only the key, for $(...)
```

## Run on

**Run on** keeps an agent's provider CLI and changes the model behind it. The agent is still Claude Code, Codex, OpenCode, or Copilot CLI. Its tool loop, permission prompts, transcripts and Maestro's session handling are the same. Only the model that answers changes, from the provider's cloud model to a model on one of your [sources](#endpoints): the [Maestro model server](#model-server), a server you run (Ollama, LM Studio), or a cloud endpoint you added.

Set it in the agent's **Models** tab, in **New Agent** or **Edit Agent**. The picker lists **Provider (default)**, then the models of each source, grouped by source. The Maestro model server comes first and lists the models you have installed. A saved source is listed only while it is enabled. Opening the tab starts nothing: the server's list comes from disk and the server is never started for it, and each enabled saved source is asked for its models.

| Control     | What it does                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run on**  | The model, by source. Each model from the Maestro model server shows its [fit label](#will-it-run-on-this-computer) and **Runs agents** when it passed with this agent's provider. |
| **Context** | The window the harness is told it has. It starts at the model's context on the server (40,960 for any other source) and cannot be lower than 40,960.                               |
| **Test**    | Sends one short, read-only turn through the agent's real launch and shows the reply or the reason it failed.                                                                       |

Under the picker, Maestro says what the launch will do: that a source was removed or is disabled, that a loopback source cannot be reached from the agent's SSH remote, or that the agent's own variable takes precedence. A model without the **Runs agents** badge shows "Not tested as an agent. Turns may fail or loop."

A turn's pill names where it ran, in place of the model: `gpt-oss 20B (MXFP4) · Maestro`, `qwen3:latest · Ollama`.

### Which providers can run on a source

Maestro maps a provider only after the recipe ran against the real CLI. A provider without a recipe keeps its picker disabled and says why.

| Provider                      | Runs on a source   | How Maestro points it at the source                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                   | Yes                | `ANTHROPIC_BASE_URL` (the server root, no `/v1`), `ANTHROPIC_AUTH_TOKEN`, the Haiku, Sonnet and Opus model variables, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and `ANTHROPIC_API_KEY` set blank. Runs as `claude --print`. Uses the Anthropic Messages route |
| Codex                         | Yes                | A provider named `maestro` through `-c model_providers.maestro=...`, `-c model_provider="maestro"` and `-c model_context_window=<n>`, the key in `MAESTRO_RUN_ON_KEY`, and `-m <model>`. Runs as `codex exec`. Uses the Responses route                                                 |
| OpenCode                      | Yes (2.0 or newer) | A `maestro` provider added to `OPENCODE_CONFIG_CONTENT`, `--standalone`, `--model maestro/<model>`, and the key in `MAESTRO_RUN_ON_KEY`. Your config file is not touched. Uses the Chat Completions route                                                                               |
| Copilot CLI                   | Yes                | The `COPILOT_PROVIDER_*` variables (base URL, key, wire model, token limits, and a neutral `COPILOT_PROVIDER_MODEL_ID`) and `--model`. GitHub sign-in is not used. Uses the Chat Completions route                                                                                      |
| Qwen3 Coder, Oh My Pi, Hermes | No                 | Each documents a way to use another server. Maestro has not run it against the real CLI, so it stays off                                                                                                                                                                                |
| Factory Droid, Pi             | No                 | They take another model server only from a settings or models file, and Maestro does not write one for a launch                                                                                                                                                                         |
| Antigravity CLI, Gemini CLI   | No                 | They speak only the Gemini API, which no source serves                                                                                                                                                                                                                                  |
| Grok CLI                      | No                 | It has a base-URL variable but no way to give a launch a key for it                                                                                                                                                                                                                     |

Copilot CLI picks its tools from the model's name, and a name it takes for a GPT model gets a tool that `llama-server` rejects. Maestro therefore tells Copilot CLI the model is called `maestro-run-on` and sends the source the model's real name.

Maestro checks that the source lists the model. It does not check that the source speaks the route the harness uses. Ollama and LM Studio serve the routes above; a server that serves only Chat Completions works with OpenCode and Copilot CLI, and a turn from the others fails with the harness's own error. Claude Code was measured against Ollama and the Maestro model server, Codex against the Maestro model server, and OpenCode and Copilot CLI against the Maestro model server with `gpt-oss 20B`.

An agent on a source keeps to the mode its recipe was measured in. Claude Code runs as `claude --print`, never through the maestro-p TUI, so the **Token source** setting on the Provider tab does not apply. Codex runs as `codex exec`, so the **Codex transport** setting does not apply.

### The rules

- **It never falls back to the provider.** A target that cannot run refuses the launch and names the reason. Silently sending the turn to the provider's cloud model would spend money you chose not to spend and send the conversation where you chose not to send it.
- **Your own variable wins, one variable at a time.** If the agent's environment variables already set a variable the recipe sets, Maestro leaves yours. If you set the base-URL variable yourself, the source's key is withheld, so a key is never sent to an address its source does not own, and Maestro does not ask the source or start the model server for that launch.
- **The provider's own key never goes to the source.** Claude Code sends `ANTHROPIC_API_KEY` to its base URL beside the source's token (measured with 2.1.296). Maestro sets it blank for the launch, whoever set it. Copilot CLI's bearer token, key command and headers for another provider are set blank in the same way.
- **A launch refused for the target starts nothing.** Maestro decides the refusals that need no network first, so a launch that will be refused does not start the model server or load a model.
- **The Maestro model server starts for the launch.** An agent set to run on it is something you turned on, so its first turn starts the server and loads the model, as an assignment does.
- **A saved source is asked on every launch.** Maestro reads its model list (5 second budget) to know it answers and serves the model.

| What is wrong                                            | What you see                                                                  | Code                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| The provider has no recipe                               | The provider's reason, and "Set Run on to Provider to run the agent"          | `run-on-unsupported-provider` |
| The stored target is not a source and a model            | What is missing. Pick a model again                                           | `run-on-invalid-target`       |
| The source was removed                                   | "its source (`<id>`) is no longer configured"                                 | `run-on-source-missing`       |
| The source is disabled                                   | The source's name, and to enable it                                           | `run-on-source-disabled`      |
| The agent is on an SSH remote and the source is loopback | The remote's name and the address it cannot reach                             | `run-on-loopback-on-remote`   |
| The source did not answer                                | The source's name and what it said                                            | `run-on-source-unreachable`   |
| The source does not serve the model                      | The model, and up to five that the source does serve                          | `run-on-model-not-served`     |
| The Maestro model server could not serve it              | The server's own reason: engine not installed, port in use, not enough memory | `run-on-server-failed`        |

Every refusal says how to recover, and every one offers to set Run on to Provider. The same message is what a Cue run, an Auto Run and `maestro-cli send` report.

### What it covers

The target applies to the turns the agent runs: chat, Auto Run, Cue runs, `maestro-cli send`, the agent's turns as a Group Chat participant, its answers to another agent's `@mention` or `maestro-cli ask`, and the History synopsis, which resumes the same session and so runs on the same target.

<Warning>
	**Some short jobs still reach the provider.** Tab naming, context grooming, the Group Chat
	moderator, and the A Cappella voice Conductor are separate spawns, and they do not follow an
	agent's Run on target. For an agent on a source, the text they read can still reach the
	provider's cloud model. To keep tab naming and summaries on your machine, assign them to a
	local model on **Models -> System Two**.
</Warning>

### SSH remote agents

A remote host cannot reach `127.0.0.1` on this machine, so an agent on an SSH remote is refused when its source is a loopback address, with the same wording as the [gateway's](#gateway) refusal. The Maestro model server is always reached at `127.0.0.1`, so a remote agent cannot run on it, even in Network mode. Give the agent a source the remote host can reach, such as an Ollama server on your network.

Over SSH a blank variable is not exported. A provider key that the remote host's own shell profile exports (`ANTHROPIC_API_KEY`, or Copilot CLI's `COPILOT_PROVIDER_BEARER_TOKEN`, `COPILOT_PROVIDER_API_KEY_COMMAND` and `COPILOT_PROVIDER_HEADERS`) is outside what a launch controls.

### Run on and the gateway

Run on and the [gateway](#gateway) do not combine. A gateway routes requests to a cloud provider, and an agent on a source sends its requests to the source. While the target is a source, both gateway controls on the Models tab are disabled with that reason. A stored gateway URL stays in the field, and is used again when you set Run on back to Provider. The launch skips the gateway and logs that it did. `maestro-cli update-agent --gateway-url` and `--proxy-mode` are refused for such an agent, but clearing them is allowed.

### Which model should I pick?

- **Start with the Library's Runs agents group.** A model is in it only after it fixed a bug in a scratch repository through a real harness, and its badge names the harnesses it passed with. The picker shows the badge for this agent's provider, so a model that passed with Claude Code only carries no badge on a Codex agent.
- **Pick by what fits.** `gpt-oss 20B (MXFP4)` is the smallest that drives Claude Code and Codex (11.3 GB). `Gemma 4 E4B` (5.2 GB) is the one that fits a 16 GB computer, where `gpt-oss 20B` needs 32 GB. `Qwen3-Coder 30B-A3B` and `Qwen3-Coder-Next 80B-A3B` are the coding agents, and `gpt-oss 120B` is the strongest reasoner. The fit label is judged for the context you set.
- **A model outside that group is a bet.** Some of the Housekeeping models cannot start a turn through the server today: their chat templates reject a system message that arrives after the first, and Claude Code and Codex send one. The picker's warning is the signal.
- **Raise the context for a project with large instruction files.** At 40,960 tokens, OpenCode compacted before its first turn and Copilot CLI refused ("Static system messages and tool definitions exceed the model's usable context budget") in a repository whose instruction files and skills made a system prompt of about 290,000 characters. Both completed at a larger window. A larger context needs more memory.
- **Keep the context at or below what the model runs at.** The Maestro model server runs a model at its catalog context. A larger number tells the harness about a window the server does not have, and Maestro does not check it today.
- **Expect a smaller model to wander on a long task.** A short, well-bounded turn works. Use **Test** before you hand the agent real work.

On the same `gpt-oss 20B` at 40,960 tokens on an Apple M5 Max (128 GB), a one-word turn took 2.7 s with Claude Code, 2.2 s with Codex, 5.8 s with OpenCode and 6.1 s with Copilot CLI.

### Testing a target

**Test** sends `Reply with the single word: ready` through the agent's own launch: its provider, directory, path, arguments, variables and SSH remote, with the form's unsaved values on top. The turn is read-only, because the model may be one nobody has run as an agent in your project directory. It waits at most 5 minutes for the turn, and loading a model is outside that budget. A Provider target has nothing to test and is refused. A test leaves one short session in the provider's own session store for the agent's directory.

From the command line the test runs on what is stored, so set the target first.

### From the command line

```bash
maestro-cli models endpoints list                                           # source ids
maestro-cli update-agent <agent-id> --run-on maestro-server:<model-id>      # the Maestro model server
maestro-cli update-agent <agent-id> --run-on <source-id>:qwen3:latest --run-on-context 65536
maestro-cli update-agent <agent-id> --run-on-context 131072                 # the context alone
maestro-cli agent test-run-on <agent-id> [--json]                           # one short turn on the stored target
maestro-cli update-agent <agent-id> --run-on provider                       # back to the provider's model
maestro-cli create-agent "Local Coder" -d . -t claude-code --run-on maestro-server:<model-id>
maestro-cli show agent <agent-id> --json   # runOn, runOnSpec, runOnLabel, runOnProblem
```

A target is written `provider` or `<source id>:<model>`. The source id ends at the first colon, so a model name may hold one. `maestro-server` is the Maestro model server; other ids are in `models endpoints list`. A source id that names nothing, a provider with no recipe, and a context under 40,960 are refused at the write. Whether the source serves the model is not asked at the write: `agent test-run-on` asks. A disabled source is accepted and is refused by name at launch until you enable it.

Two rules for what changes around a target. Switching an agent's provider keeps the target when the new provider has a recipe, and clears it when it has none. A worktree agent inherits its parent's target, for the reason it inherits the gateway.

## Tiers

A **tier** says how much model a job needs: `low`, `medium` or `high`. An Auto Run task asks for one with `<!-- MAESTRO:MODEL tier="low" -->` (see [Model Tier and Effort](./autorun-playbooks#model-tier-and-effort)), and a Cue subscription with `tier: low`. Maestro turns the tier into a model when the task launches.

Run on gives an agent one target. Tiers let one agent use several: a `low` task can launch on a model on this machine, and the next `high` task on the provider. A switch happens only between tasks, because each task is a new process.

A tier's **target** is one of two things:

| Target              | Spelling                          | What launches                                                                      |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| A provider model    | `provider:<model>`, or `provider` | The provider's own model. `provider` alone means the agent's own model             |
| A model on a source | `<source id>:<model>`             | The same harness, running on that model, as if the agent's Run on target were that |

### Where a tier's target comes from

Maestro reads three layers when the task launches, and the first one that sets the tier wins.

| Layer               | Where you set it                                      | How it applies                                                                                                                                                 |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**           | **Edit Agent -> Models -> Tiers**                     | Wins for the tiers it sets. A tier left on **Harness default** falls through                                                                                   |
| **Harness default** | **Settings -> Models -> System Two -> Tier defaults** | Every agent on that harness that does not set the tier follows it, and a change applies at the next launch                                                     |
| **Built-in**        | Maestro's own table                                   | The starting value of the harness default, and what **Reset** goes back to. Claude Code `haiku`, `sonnet` and `opus`; Codex Luna, Sol and Astra; Factory Droid |

If no layer maps a tier (OpenCode and Copilot CLI have no built-in row), the task runs on the agent's own model and its log says the tier was ignored. Maestro does not guess a model for it.

Every surface that shows a tier also shows which layer it came from: **Agent**, **Harness default** or **Built-in**.

### Tier defaults

**Settings -> Models -> System Two -> Tier defaults** has one row per installed harness that can select a model, with a picker for each of `low`, `medium` and `high`, and the layer beside each value. A picker lists what that harness can run on this computer:

- the harness's own list of models (Maestro reads it from the harness, for example Codex's model cache or `opencode models`), and
- every [Run on](#run-on) target the harness can use: the Maestro model server and each enabled source.

Opening System Two reads those lists. Nothing is written until you press **Save** on a row, because a document has to resolve the same way until you change it.

| Button      | What it does                                                              |
| ----------- | ------------------------------------------------------------------------- |
| **Suggest** | Fills the pickers from what the harness lists, with the reason under each |
| **Reset**   | Puts the pickers back on the built-in table                               |
| **Discard** | Drops your edits to the row                                               |
| **Save**    | Stores the row. Suggest and Reset change the pickers only                 |

**Suggest** uses a family Maestro knows for that harness (Claude Code's aliases, the newest Codex Luna, Sol and Astra), then the built-in model when the list holds it, then a description that says "fast" or "frontier", and, for `medium`, the model listed first. It does not pick a family out of another harness's list: OpenCode and Copilot CLI list several Claude and GPT models at once, so those tiers stay blank with the reason. A tier with no suggestion keeps the value it has.

A value the harness no longer lists is flagged on its row, with the model **Suggest** would put in its place.

### Per agent

**Edit Agent -> Models -> Tiers** has one picker per tier. The first choice is **Harness default (`<value>`)**, which follows the table above. The others are the same targets the Tier defaults table offers. Tiers save with the dialog, like Run on. Switching an agent's provider starts its tiers over, because a tier names a model. New Agent has no Tiers block: a new agent follows the harness defaults, and you can edit it afterwards.

### The rules

- **A tier that names a target that cannot run fails the task by name.** The task does not start, and it does not fall through to the next layer or to the provider. A layer you wrote is never replaced by one you did not.
- **The built-in table does not apply to an agent that runs on a source.** The table names the provider's cloud models, and sending that agent there is the spend Run on is meant to prevent. Such an agent keeps its own Run on target, and the task says the tier was ignored. A tier you set on the agent or in the harness default does move it.
- **A source target launches at the default context**, 40,960 tokens. The tiers have no context field.
- **The pill names the target.** An Auto Run marker reads `low · qwen3.5-4b · Maestro` or `high · opus`. A tier no layer maps keeps the plain `low model`.
- **Auto Run splits a document where the model or the place changes.** A `low` task on the Maestro model server and a `high` task on the provider run as two dispatches.

### What it covers

Tiers apply to Auto Run (in the app and from `maestro-cli`) and to Cue subscriptions. Tab naming, summaries and context grooming are not tiered: they ask for the provider's own cheap model and run on the agent's own target. `maestro-cli send` takes no `--tier`.

### From the command line

```bash
maestro-cli models tiers list [--harness <id>]            # each tier, its value and the layer
maestro-cli models tiers options <harness> [--refresh]    # what the harness can launch a tier on
maestro-cli models tiers suggest <harness> [--apply]      # a suggestion per tier, with the reason
maestro-cli models tiers set <harness> low maestro-server:<model-id>
maestro-cli models tiers set <harness> high provider:opus
maestro-cli models tiers reset <harness> [--tier low]     # back to the built-in table

maestro-cli update-agent <agent-id> --tier low=<source id>:<model> --tier high=provider:opus
maestro-cli update-agent <agent-id> --tier low=default    # back to the harness default
maestro-cli show agent <agent-id> --json                  # tiers: value, spelling and layer of each
```

A target is written `default`, `provider`, `provider:<model>` or `<source id>:<model>`. The source id ends at the first colon. `--tier` is repeatable and changes only the tiers it names. `models tiers set` and `reset` write at once; the table in Settings writes on **Save**.

## Gateway

A gateway is an HTTP proxy that an agent's requests go through on the way to its provider. People run one to cut the tokens an agent sends ([Headroom](https://github.com/chopratejas/headroom) compresses large tool results), or to route and meter traffic ([LiteLLM](https://github.com/BerriAI/litellm)). The Gateway section lists your agents and lets you give each one a gateway URL. The same field is in each agent's **Edit Agent** dialog.

The gateway table is on **Models -> Gateway**. A gateway is set per agent and is off until you type a URL. When the agent next starts, Maestro points the provider's CLI at that URL:

| Provider    | How it is pointed at the gateway                                           |
| ----------- | -------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_BASE_URL`                                                       |
| Codex       | `OPENAI_BASE_URL`, and the argument `-c openai_base_url="<url>"`           |
| Copilot CLI | Nothing. Copilot CLI ignores base-URL variables, so the field is disabled. |
| OpenCode    | Nothing. It sets a base URL per model provider in its own config file.     |
| Others      | Nothing known to Maestro. The field is disabled and says so.               |

Codex gets both because Codex CLI does not read `OPENAI_BASE_URL` on a ChatGPT login (tested with 0.162.1); the argument is what it honors.

A gateway sends an agent's requests to its cloud provider by another route. To send them to a model on another server instead, use [Run on](#run-on). The two do not combine: while an agent's Run on target is a source, its gateway is not applied.

Four rules:

- **Your own variable wins.** If the agent's environment variables already set the base-URL variable, Maestro leaves your value alone and the gateway is not applied. The field says so. The gateway does win over a value set for every agent in Settings -> Environment, because a gateway on one agent is the more specific choice.
- **A gateway that cannot be used stops the agent.** The agent does not start, and the message names the gateway. Maestro never sends the turn to a different endpoint than the one you chose. If the proxy is not running, the agent's own connection error is what you see.
- **A loopback gateway does not work for an SSH remote agent.** `http://127.0.0.1:8787` on this machine is a different machine from the remote host's point of view, so the agent is refused at launch. Give it a URL the remote host can reach.
- **It covers the turns the agent runs.** Chat, Auto Run, Cue runs, `maestro-cli send`, the agent's turns as a Group Chat participant, and its answers to another agent's `@mention` or `maestro-cli ask` go through the gateway. Short jobs Maestro runs beside an agent (tab naming, context grooming, Director's Notes) and the Group Chat moderator do not: they reach the provider direct.

Each row with a gateway has **Show environment**, which lists the agent's effective environment variables and where each came from. The base-URL variable is marked **Local Models gateway**, or marked with the layer that beat it.

An agent on a subscription login (Claude or Codex) saves quota, not dollars. Sending its traffic through a proxy is your choice for each agent, and you are responsible for your provider's terms.

From the command line:

```bash
maestro-cli update-agent <agent-id> --gateway-url http://127.0.0.1:8787
maestro-cli update-agent <agent-id> --gateway-url none
maestro-cli show agent <agent-id> --json   # gatewayUrl
```

### The Maestro proxy

Maestro has a proxy of its own, so you do not need to run one to save tokens. Each row of the Gateway table has a **Maestro proxy** control with four modes:

| Mode               | What happens to the agent's requests                                       |
| ------------------ | -------------------------------------------------------------------------- |
| **Off**            | They do not go through Maestro's proxy. This is the default.               |
| **Passthrough**    | They go through it unchanged. Maestro only counts them.                    |
| **Compress**       | A large tool result is shortened after the model has read it once in full. |
| **Compress early** | A large tool result is shortened before the model first reads it.          |

Choosing any mode but Off sets the agent's gateway URL to the proxy for you. Choosing Off clears it. The proxy listens on `127.0.0.1` only, starts when the first agent uses it, and stops when none do.

**Which compress mode to pick.** The note under the control says the same thing in one sentence.

- **Compress** changes nothing about what the model works from: it reads every tool result in full, and the result is shortened only once it is history. The cost is that the result is written to your provider's prompt cache twice, in full and then shortened. Measured on Claude Code, that made a short session (4 to 6 requests) cost between 2% and 36% more than Passthrough, depending on the output, and it pays back only in a longer one. Pick it for long sessions where you want the model to see everything once.
- **Compress early** shortens a result before the model sees it, so nothing is ever cached in full and it is the cheapest mode. In a measured four-turn session it cost 14% less than Passthrough, where Compress cost 36% more. The model works from the shortened output (repeated log lines folded, long lists and lines cut), which is the trade. It can run a narrower command when it needs a part that was cut. Pick it when the tool output is mostly build logs, test runs, and listings.

What both compress modes do, and do not do:

- **They shorten only tool results**, and only ones over about 1,000 tokens. Your messages, the system prompt, tool definitions, and the agent's own text are never changed.
- **The same text always shortens to the same bytes.** Each result is keyed by a SHA-256 hash of its content and the first result is kept, so your provider's prompt cache keeps working.
- **Every change is marked and kept.** A shortened block ends with `[maestro-compressed sha256=... original_tokens=...]`, and the original stays on this machine.
- **If shortening fails, the request is sent as it arrived.** You do not lose a turn to it.
- **A local model is optional.** Rules do most of the work (minified JSON, repeated log lines folded, long lines cut). Assign the **Token proxy** task a model on **Models -> System Two** to also summarize results that are still very large.

Under the table, **Maestro token proxy** shows what it did in the last 30 days, in all and per agent: requests, tokens saved, and the average time a request was held to be shortened. Tokens saved is an estimate at 4 characters per token. On output full of paths, digits and stack traces the real saving can be about twice the figure shown. **Recent compressions** lists the blocks it last shortened. Select one to see a diff of what the agent sent against what was sent in its place.

The proxy cannot be used by an agent on an SSH remote (the remote host cannot reach this machine's `127.0.0.1`) or by a provider with no base-URL variable. The control is disabled for those and says why. A turn started with `maestro-cli send` goes through the proxy unchanged and is counted without an agent name, because only the app tells the proxy which agent a request belongs to.

```bash
maestro-cli update-agent <agent-id> --proxy-mode compress   # off | passthrough | compress | compress-early
maestro-cli show agent <agent-id> --json                    # tokenProxyMode
maestro-cli models proxy status                             # the listener, agents, totals, recent compressions
maestro-cli models proxy block <hash>                       # a diff of one shortened block
```

### Background requests

Claude Code sends work that is not your conversation on its small model: a session title, and the summary of a web page the agent fetched. **Background requests** sends exactly those to a model on one of your [sources](#endpoints), while the agent's own turns keep going to the provider. It is off until you pick a target.

It is on **Edit Agent -> Models**, under the Maestro proxy mode, and is shown only for a Claude Code agent whose proxy mode is not Off. The picker lists the models of the sources that serve the Anthropic Messages route: the [Maestro model server](#model-server), Ollama and LM Studio. An OpenAI-compatible source is not listed, because Maestro cannot tell that it serves that route. Like the mode above it, the choice applies at once, with no restart.

**What is routed.** The proxy decides per request. A request goes to the target only when it names the provider's small model and shows no sign of being a turn. Everything else reaches the provider exactly as it arrived.

| A request that...                                       | Goes to      |
| ------------------------------------------------------- | ------------ |
| Does not name the small model (Claude's `haiku`)        | The provider |
| Carries a `thinking` or `redacted_thinking` block       | The provider |
| Has a cache breakpoint anywhere but the system prompt   | The provider |
| Carries a tool result, or declares tools                | The provider |
| Asks for one token or fewer (Claude Code's quota probe) | The provider |
| Is none of the above                                    | The target   |

The agent's main loop never changes model in the middle of a session. A routed request is the client's request with one value changed, the model's name.

**The rules.**

- **A target that cannot answer fails the request, and it is not retried on the provider.** The agent sees the target's own error, or a `502 background-target-unavailable` from the proxy that names the target when it cannot be used at all (the source was removed or disabled, the model server cannot serve the model). Retrying on the provider would hide the failure and spend the money you chose to save.
- **The provider's credentials never go to the target.** A routed request carries the target's key as a bearer token. The client's `Authorization`, `x-api-key` and `cookie` headers are removed from it.
- **Nothing starts for a turn.** The target is looked up, and the Maestro model server started, only for a request already decided to be a background request.
- **A model that thinks makes a page take a minute.** The request states no thinking setting, so the server applies the model's own template, and a thinking model reasons first. Pick a model that answers without thinking.
- **The target leaves with the proxy.** Turning the proxy mode Off, setting another gateway URL, or switching the agent's provider clears the background target. An agent whose [Run on](#run-on) is a source is not on the proxy, so it cannot have one.

**What a session showed.** Measured on Claude Code 2.1.296 with a three-turn session (a build log, a fetched page, a one word reply) and Qwen3.5 4B on the Maestro model server:

| Mode             | Requests | Routed                                 | Share of the prompt cost |
| ---------------- | -------- | -------------------------------------- | ------------------------ |
| `claude --print` | 7        | 1 (the page summary)                   | 0.7%                     |
| The TUI          | 13       | 2 (the session title and page summary) | 2.1%                     |

- **Print mode, which is how Maestro starts Claude Code unless the agent uses the TUI token source, routes one kind of request: the page summary.** A session that fetches no page routes nothing. The TUI also sends a session title, and in a `maestro-p` turn nothing reads it, because the TUI exits when the turn ends.
- **The agent reads the local model's summary of the page.** The summary is the web fetch tool's result, so it is not a side effect. Every summary was right on a one paragraph page.
- **The saving per session is small.** It is the provider's own count for the requests that were routed, so it grows with the size and number of the pages fetched.
- **The cost is time, and it depends on the model.** A page summary took 1 to 3 s on the provider, 0.56 s on Qwen3 Coder 30B, 2.1 s on gpt-oss 20B, and 49 to 84 s on Qwen3.5 4B, which wrote 4,860 to 8,241 tokens of reasoning first.

A permission check on the small model was not seen in either session. The only shell command, `cat`, was allowed by a rule, so this is "not sent here", not "never sent".

```bash
maestro-cli update-agent <agent-id> --proxy-mode passthrough --background-requests maestro-server:<model-id>
maestro-cli update-agent <agent-id> --background-requests none
maestro-cli show agent <agent-id> --json   # backgroundRequests, backgroundRequestsSpec, backgroundRequestsProblem
```

A target is written `<source id>:<model>`, or `none`. A target is refused for an agent that is not on the proxy, and for a provider other than Claude Code. The app's system log names each routed request and its target.

## Privacy

A downloaded model runs inside Maestro, so the text it reads never leaves your machine. An endpoint at a loopback address (`127.0.0.1`, `localhost`, `::1`) is also on your machine.

An endpoint at any other address is a network service. Text sent to it leaves this machine, the same as text sent to an agent's provider. Point a task at a remote endpoint only if you would send that text there yourself.

An agent set to [Run on](#run-on) a source sends it the whole conversation: your prompts, the files the agent reads, and every tool result. A model on this machine keeps that text here. A cloud endpoint, or a server at another address, receives it, so choose one only if you would send that text there yourself.

An agent with [tiers](#tiers) set to a source sends that source each task that asks for the tier, with the same conversation. An agent with [background requests](#background-requests) sends its target the page a web fetch read, or the text a session title is made from. Both go where you picked, and neither goes to the provider as well.

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
maestro-cli models list [--kind <kind>] [--fit]  # the Library in its groups, with status, what each model is good at, and what uses it; --fit adds Fits / Tight / Too large
maestro-cli models install <model-id>            # download and verify, with its engine; waits until done; resumes a paused download
maestro-cli models pause <model-id>              # stop a running download, keep what arrived
maestro-cli models cancel <model-id>             # stop a download and delete its partial files
maestro-cli models verify <model-id>             # re-hash; never deletes or re-downloads
maestro-cli models remove <model-id> [--force]   # refuses a model a task uses, unless --force
maestro-cli models add-hf <repo> <file> [--dry-run]  # add a GGUF from Hugging Face; prints its license; downloads nothing
maestro-cli models remove-hf <model-id> [--force]    # take an added model out of the Library and delete its files
maestro-cli models config show                   # the download base in force
maestro-cli models config set download-base <url|default>  # a mirror for Hugging Face; works with Maestro closed
maestro-cli models runtimes list                 # the engines: state, size, and the models each runs
maestro-cli models runtimes install <onnx|llama> # install or update one engine on its own

maestro-cli models endpoints list
maestro-cli models endpoints detect              # probe for Ollama and LM Studio; adds nothing
maestro-cli models endpoints add --kind ollama [--url <url>] [--name <name>] [--api-key-env <VAR>]
maestro-cli models endpoints update <endpoint> [--name <name>] [--url <url>] [--kind <kind>] [--api-key-env <VAR> | --clear-api-key-env] [--enable | --disable]
maestro-cli models endpoints models <endpoint>   # the models the server lists now, for `assign endpoint:...`
maestro-cli models endpoints test <endpoint> [--model <model>]
maestro-cli models endpoints remove <endpoint>

maestro-cli models server status [--json]        # the Maestro model server (see "Model server")
maestro-cli models server start|stop
maestro-cli models server set [--bind local|network] [--max-models <n>] [--rotate-key] [--build default|cpu|cuda|rocm]
maestro-cli models server key                    # prints only the key

maestro-cli models tasks                         # every task, its assignment, and readiness
maestro-cli models assign <task-id> off
maestro-cli models assign <task-id> utility-agent
maestro-cli models assign <task-id> local:<model-id>
maestro-cli models assign <task-id> endpoint:<endpoint>:<model>
maestro-cli models assign cue-gate system-one    # ask the System One engine in force (a task with typed questions only)
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
