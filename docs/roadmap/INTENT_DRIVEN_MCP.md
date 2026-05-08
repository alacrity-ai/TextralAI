# Intent driven MCP operations

Our MCP operations right now are pretty low-level, it might make sense to add some intent driven things for common operations.

Here's the converastion that inspired this idea:

Because the model inferred that your MCP tool likely accepts **serialized content payloads**, not filesystem handles.

This is an emergent behavior from tool reasoning, not something intrinsic to MCP itself.

What likely happened internally:

```txt id="mkj4jx"
1. Claude saw:
   "ingest all files in ./docs"

2. Claude inspected available tools.

3. Your textral MCP tool schema probably looked something like:
   ingest_document({
      title,
      content,
      mime_type
   })

   or:
   upload_bytes({
      body_base64
   })

4. Claude concluded:
   "I need transport-safe binary/text serialization."

5. It chose base64 as the safest universal encoding.
```

This is actually rational behavior.

The key point:

```txt id="2l5hmr"
Claude does not understand your ingestion semantics.
It only understands tool contracts.
```

So if the contract implies:

```txt id="zn3hh1"
opaque bytes
```

the safest transformation is:

```txt id="0k8jje"
base64
```

especially because:

* markdown
* PDFs
* images
* binaries
* UTF-8 ambiguity
* newline escaping

all disappear as concerns once encoded.

---

# Why this commonly happens in MCP

Most MCP tool invocations are JSON-shaped:

```json id="8ijbnp"
{
  "path": "...",
  "content": "..."
}
```

JSON is poor at arbitrary byte transport.

So models learn patterns like:

```txt id="q5q8l0"
"binary-like thing"
→ base64
```

This is especially likely if:

* your tool descriptions mention "bytes"
* schemas mention `content_base64`
* prior examples used base64
* tool accepts inline file bodies
* model lacks certainty about encoding guarantees

---

# The deeper reason

Claude is attempting to optimize for:

```txt id="mnw27u"
deterministic transport correctness
```

not elegance.

From the model's perspective:

```txt id="jvse9t"
base64 is ugly
but reliable
```

---

# How to stop this behavior

You need to make the ingestion path more semantically obvious.

Right now the model probably thinks:

```txt id="w5vybo"
"I must inline file contents into the tool call."
```

You instead want it thinking:

```txt id="j4a3e2"
"The tool itself can read files from disk."
```

or:

```txt id="fjlwmn"
"The tool accepts filesystem paths."
```

---

# Best fix: add a path-native ingestion tool

Instead of:

```ts id="wz7pm6"
ingest_document({
  filename,
  content_base64
})
```

create:

```ts id="i0s4xz"
ingest_local_file({
  path,
  namespace,
  profile
})
```

or even better:

```ts id="2p0n3y"
ingest_local_directory({
  directory,
  namespace,
  recursive,
  glob
})
```

Then Claude will naturally do:

```txt id="m0v0qf"
filesystem discovery
→ pass paths directly
```

instead of:

```txt id="n5a3m0"
filesystem discovery
→ serialize all files
→ upload opaque blobs
```

---

# Another strong fix: improve tool descriptions

Example:

BAD:

```txt id="jlwmn2"
Upload document bytes into Textral.
```

BETTER:

```txt id="txkqdc"
Ingests UTF-8 text/markdown files directly from the local filesystem.
Pass filesystem paths instead of base64 whenever possible.
```

Models are *extremely* sensitive to tool wording.

---

# Another likely cause

You may accidentally have created a tool shape that resembles OpenAI file upload semantics.

If your tool schema resembles:

```json id="aw7aeb"
{
  "filename": "...",
  "content": "..."
}
```

Claude will frequently infer:

```txt id="xwlvca"
content == opaque serialized payload
```

because that pattern strongly resembles:

* multipart upload
* SDK byte upload
* OpenAI file APIs
* S3 PUT semantics

---

# Important observation

The fact that Claude:

* listed files
* created namespace
* batched ingestion
* created manifests
* parallelized work

means your MCP design is actually working very well.

The base64 step is merely a transport heuristic.

---

# What I'd recommend for Textral

Add high-level semantic tools:

```txt id="dzq2t9"
ingest_local_directory
ingest_local_file
sync_github_repo
sync_confluence_space
sync_jira_project
```

rather than low-level:

```txt id="e5xmsn"
upload_bytes
upload_blob
put_document
```

because MCP shines most when tools represent:

```txt id="3lg9fj"
intent-level operations
```

not transport primitives.

That is the major conceptual shift from REST APIs to agent-native systems.
