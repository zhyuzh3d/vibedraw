# VibeDraw ComfyUI plugin

This package adds `VibeDraw Input` and `VibeDraw Output` nodes plus a small
server-side adapter. A client submits an API-format workflow containing one
`VibeDrawInput` node and one or more `VibeDrawOutput` nodes to
`POST /vibedraw/v1/jobs`. The adapter stages the transient reference image and
mask, patches the input node, queues the normal ComfyUI graph, and exposes the
native output filenames through `GET /vibedraw/v1/jobs/{job_id}`.

The package is installed by copying `vibedraw_comfy/` into ComfyUI's
`custom_nodes/` directory. A ZIP is only a distribution convenience.

When ComfyUI is behind an authenticated control plane such as the A1X
runtime, the control plane must proxy `/vibedraw/v1/*` and `/view` to its
loopback ComfyUI backend. VibeDraw then uses the control-plane URL (for A1X,
`http://<device-ip>:8188`) and sends the configured Bearer password; the
backend itself can remain bound to `127.0.0.1`.

## Workflow contract

Connect the outputs of `VibeDraw Input` to the normal ComfyUI graph:

- `prompt` and `negative_prompt` to the two text encoders;
- `image` and `mask` to the model's image/inpaint path;
- `seed`, `ref_strength`, `steps`, `width`, and `height` to the relevant
  sampler/latent inputs;
- the final `IMAGE` to `VibeDraw Output`.

The API adapter does not infer which sampler or inpaint path a workflow needs;
the workflow author decides that in ComfyUI.
