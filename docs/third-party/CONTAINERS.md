---
title: Containers
description: Run serverless containers alongside Workers to handle resource-intensive workloads, custom runtimes, and existing container images on Cloudflare.
image: https://developers.cloudflare.com/dev-products-preview.png
---

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/containers/llms.txt  
> Use this file to discover all available pages before exploring further.

[Skip to content](#%5Ftop) 

# Containers

Enhance your Workers with serverless containers

 Available on Workers Paid plan 

Run code written in any programming language, built for any runtime, as part of apps built on [Workers](https://developers.cloudflare.com/workers).

Deploy your container image to Region:Earth without worrying about managing infrastructure - just define your Worker and [wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/general/#deploy).

With Containers you can run:

* Resource-intensive applications that require CPU cores running in parallel, large amounts of memory or disk space
* Applications and libraries that require a full filesystem, specific runtime, or Linux-like environment
* Existing applications and tools that have been distributed as container images

Container instances are spun up on-demand and controlled by code you write in your [Worker](https://developers.cloudflare.com/workers). Instead of chaining together API calls or writing Kubernetes operators, you just write JavaScript:

* [ Worker Code ](#tab-panel-5082)
* [ Worker Config ](#tab-panel-5083)

JavaScript

```

import { Container, getContainer } from "@cloudflare/containers";


export class MyContainer extends Container {

  defaultPort = 4000; // Port the container is listening on

  sleepAfter = "10m"; // Stop the instance if requests not sent for 10 minutes

}


export default {

  async fetch(request, env) {

    const { "session-id": sessionId } = await request.json();

    // Get the container instance for the given session ID

    const containerInstance = getContainer(env.MY_CONTAINER, sessionId);

    // Pass the request to the container instance on its default port

    return containerInstance.fetch(request);

  },

};


```

* [  wrangler.jsonc ](#tab-panel-5080)
* [  wrangler.toml ](#tab-panel-5081)

JSONC

```

{

  "name": "container-starter",

  "main": "src/index.js",

  // Set this to today's date

  "compatibility_date": "2026-05-01",

  "containers": [

    {

      "class_name": "MyContainer",

      "image": "./Dockerfile",

      "max_instances": 5

    }

  ],

  "durable_objects": {

    "bindings": [

      {

        "class_name": "MyContainer",

        "name": "MY_CONTAINER"

      }

    ]

  },

  "migrations": [

    {

      "new_sqlite_classes": ["MyContainer"],

      "tag": "v1"

    }

  ]

}


```

TOML

```

name = "container-starter"

main = "src/index.js"

# Set this to today's date

compatibility_date = "2026-05-01"


[[containers]]

class_name = "MyContainer"

image = "./Dockerfile"

max_instances = 5


[[durable_objects.bindings]]

class_name = "MyContainer"

name = "MY_CONTAINER"


[[migrations]]

new_sqlite_classes = [ "MyContainer" ]

tag = "v1"


```

[ Get started ](https://developers.cloudflare.com/containers/get-started/) [ Containers dashboard ](https://dash.cloudflare.com/?to=/:account/workers/containers) 

---

## Next Steps

###  Deploy your first Container 

Build and push an image, call a Container from a Worker, and understand scaling and routing.

[ Deploy a Container ](https://developers.cloudflare.com/containers/get-started/) 

###  Container Examples 

See examples of how to use a Container with a Worker, including stateless and stateful routing, regional placement, Workflow and Queue integrations, AI-generated code execution, and short-lived workloads.

[ See Examples ](https://developers.cloudflare.com/containers/examples/) 

---

## More resources

[Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/containers/#containers) 

Learn more about the commands to develop, build and push images, and deploy containers with Wrangler.

[Limits](https://developers.cloudflare.com/containers/platform-details/limits/) 

Learn about what limits Containers have and how to work within them.

[SSH](https://developers.cloudflare.com/containers/ssh/) 

Connect to running Container instances with SSH through Wrangler.

[Containers Discord](https://discord.cloudflare.com) 

Connect with other users of Containers on Discord. Ask questions, show what you are building, and discuss the platform with other developers.

```json
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"/directory/","name":"Directory"}},{"@type":"ListItem","position":2,"item":{"@id":"/containers/","name":"Containers"}}]}
```

---
title: Containers
description: Wrangler commands for interacting with Cloudflare's Container Platform.
image: https://developers.cloudflare.com/dev-products-preview.png
---

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/workers/llms.txt  
> Use this file to discover all available pages before exploring further.

[Skip to content](#%5Ftop) 

# Containers

Interact with [Containers](https://developers.cloudflare.com/containers/) using Wrangler.

### `build`

Build a Container image from a Dockerfile.

```

wrangler containers build [PATH] [OPTIONS]


```

* `PATH` ` string ` optional  
   * Path for the directory containing the Dockerfile to build.
* `-t, --tag` ` string ` required  
   * Name and optionally a tag (format: "name:tag").
* `--path-to-docker` ` string ` optional  
   * Path to your docker binary if it's not on `$PATH`.  
   * Default: "docker"
* `-p, --push` ` boolean ` optional  
   * Push the built image to Cloudflare's managed registry.  
   * Default: false

### `delete`

Delete a Container (application).

```

wrangler containers delete <CONTAINER_ID> [OPTIONS]


```

* `CONTAINER_ID` ` string ` required  
   * The ID of the Container to delete.

### `images`

Perform operations on images in your containers registry.

#### `images list`

List images in your containers registry.

```

wrangler containers images list [OPTIONS]


```

* `--filter` ` string ` optional  
   * Regex to filter results.
* `--json` ` boolean ` optional  
   * Return output as clean JSON.  
   * Default: false

#### `images delete`

Remove an image from your containers registry.

```

wrangler containers images delete [IMAGE] [OPTIONS]


```

* `IMAGE` ` string ` required  
   * Image to delete of the form `IMAGE:TAG`

### `registries`

Configure and view registries available to your container.[Read more](https://developers.cloudflare.com/containers/platform-details/image-management/#using-amazon-ecr-container-images) about our currently supported external registries.

#### `registries list`

List registries your containers are able to use.

```

wrangler containers registries list [OPTIONS]


```

* `--json` ` boolean ` optional  
   * Return output as clean JSON.  
   * Default: false

#### `registries configure`

Configure a new registry for your account.

```

wrangler containers registries configure [DOMAIN] [OPTIONS]


```

* `DOMAIN` ` string ` required  
   * Domain to configure for the registry.
* `--public-credential` ` string ` required  
   * The public part of the registry credentials, e.g. `AWS_ACCESS_KEY_ID` for ECR
* `--secret-store-id` ` string ` optional  
   * The ID of the secret store to use to store the registry credentials
* `--secret-name` ` string ` optional  
   * The name Wrangler should store the registry credentials under

When run interactively, wrangler will prompt you for your secret and store it in Secrets Store. To run non-interactively, you can send your secret value to wrangler through stdin to have the secret created for you.

#### `registries delete`

Remove a registry configuration from your account.

```

wrangler containers registries delete [DOMAIN] [OPTIONS]


```

* `DOMAIN` ` string ` required  
   * domain of the registry to delete

#### `registries credentials`

Generate temporary credentials to push or pull images from the Cloudflare managed registry (`registry.cloudflare.com`).

```

wrangler containers registries credentials [OPTIONS]


```

* `--push` ` boolean ` optional  
   * Generate credentials with push permission.
* `--pull` ` boolean ` optional  
   * Generate credentials with pull permission.
* `--expiration-minutes` ` number ` optional  
   * How long the credentials should be valid for (in minutes).  
   * Default: 15

At least one of `--push` or `--pull` must be specified.

### `info`

Get information about a specific Container, including top-level details and a list of instances.

```

wrangler containers info <CONTAINER_ID> [OPTIONS]


```

* `CONTAINER_ID` ` string ` required  
   * The ID of the Container to get information about.

### `instances`

List all Container instances for a given application. Displays instance ID, name, state, location, version, and creation time.

In interactive mode, results are paginated. Press `Enter` to load the next page or `Esc`/`q` to stop. In non-interactive environments (for example, when piping output or running in CI), all pages are fetched automatically.

Use the `--json` flag to return output as a flat JSON array. Each element contains the fields `id`, `name`, `state`, `location`, `version`, and `created`. This is also the default output format in non-interactive environments.

```

wrangler containers instances <APPLICATION_ID> [OPTIONS]


```

* `APPLICATION_ID` ` string ` required  
   * The UUID of the application to list instances for. Use `wrangler containers list` to find application IDs.
* `--per-page` ` number ` optional  
   * Number of instances per page.  
   * Default: 25
* `--json` ` boolean ` optional  
   * Return output as clean JSON.  
   * Default: false

For example, to list instances for an application:

Terminal window

```

wrangler containers instances 12345678-abcd-1234-abcd-123456789abc


```

```

INSTANCE                              NAME        STATE          LOCATION  VERSION  CREATED

a1b2c3d4-e5f6-7890-abcd-ef1234567890  worker-12   running        sfo06     3        2025-06-01T12:00:00Z

b2c3d4e5-f6a7-8901-bcde-f12345678901  worker-47   provisioning   iad01     2        2025-06-01T13:00:00Z


```

To get the same data as JSON:

Terminal window

```

wrangler containers instances 12345678-abcd-1234-abcd-123456789abc --json


```

```

[

  {

    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",

    "name": "worker-12",

    "state": "running",

    "location": "sfo06",

    "version": 3,

    "created": "2025-06-01T12:00:00Z"

  }

]


```

### `list`

List the Containers in your account.

```

wrangler containers list [OPTIONS]


```

### `push`

Push a tagged image to a Cloudflare managed registry, which is automatically integrated with your account.

```

wrangler containers push [TAG] [OPTIONS]


```

* `TAG` ` string ` required  
   * The name and tag of the container image to push.
* `--path-to-docker` ` string ` optional  
   * Path to your docker binary if it's not on `$PATH`.  
   * Default: "docker"

### `ssh`

Connect to a running Container instance using SSH. Refer to [SSH](https://developers.cloudflare.com/containers/ssh/) for configuration details.

```

wrangler containers ssh <INSTANCE_ID>


```

You can also specify a command to run, instead of the default shell. For example:

```

wrangler containers ssh <INSTANCE_ID> -- ls -al


```

* `INSTANCE_ID` ` string ` required  
   * The ID of the Container instance to SSH into.

```json
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"/directory/","name":"Directory"}},{"@type":"ListItem","position":2,"item":{"@id":"/workers/","name":"Workers"}},{"@type":"ListItem","position":3,"item":{"@id":"/workers/wrangler/","name":"Wrangler"}},{"@type":"ListItem","position":4,"item":{"@id":"/workers/wrangler/commands/","name":"Commands"}},{"@type":"ListItem","position":5,"item":{"@id":"/workers/wrangler/commands/containers/","name":"Containers"}}]}
```


---
title: SSH
description: Connect to running container instances with SSH.
image: https://developers.cloudflare.com/dev-products-preview.png
---

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/containers/llms.txt  
> Use this file to discover all available pages before exploring further.

[Skip to content](#%5Ftop) 

# SSH

Anyone with write access to a Container can SSH into it with Wrangler as long as SSH is enabled.

## Configure SSH

SSH can be configured in your [Container's configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#containers) with the `ssh` and `authorized_keys` properties. Only the `ssh-ed25519` key type is supported.

The `ssh.enabled` property only controls whether you can SSH into a Container through Wrangler. If `ssh.enabled` is false but keys are still present in `authorized_keys`, the SSH service will still be started on the Container.

## Connect with Wrangler

To SSH into a Container with Wrangler, you must first enable SSH in your Container configuration. The following example shows a basic configuration:

* [  wrangler.jsonc ](#tab-panel-5150)
* [  wrangler.toml ](#tab-panel-5151)

JSONC

```

{

  "containers": [

    {

      // other options here...

      "ssh": {

        "enabled": true

      },

      "authorized_keys": [

        {

          "name": "<NAME>",

          "public_key": "<YOUR_PUBLIC_KEY_HERE>"

        }

      ]

    }

  ]

}


```

TOML

```

[[containers]]

[containers.ssh]

enabled = true


[[containers.authorized_keys]]

name = "<NAME>"

public_key = "<YOUR_PUBLIC_KEY_HERE>"


```

For more information on configuring SSH, refer to [SSH configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#ssh).

Find the instance ID for your Container by running [wrangler containers instances](https://developers.cloudflare.com/workers/wrangler/commands/containers/#containers-instances) or in the [Cloudflare dashboard ↗](https://dash.cloudflare.com/?to=/:account/workers/containers). The instance you want to SSH into must be running. SSH will not start a stopped Container, and an active SSH connection alone will not keep a Container alive.

Once SSH is configured and the Container is running, open the SSH connection with:

Terminal window

```

wrangler containers ssh <INSTANCE_ID>


```

## Process visibility

Without the [containers\_pid\_namespace](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#use-an-isolated-pid-namespace-for-containers) compatibility flag, all processes inside the VM are visible when you connect to your Container through SSH. This flag is turned on by default for Workers with a [compatibility date](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) of `2026-04-01` or later.

```json
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"/directory/","name":"Directory"}},{"@type":"ListItem","position":2,"item":{"@id":"/containers/","name":"Containers"}},{"@type":"ListItem","position":3,"item":{"@id":"/containers/ssh/","name":"SSH"}}]}
```

