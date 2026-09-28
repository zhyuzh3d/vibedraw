import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "hermit.json"), "utf8"));
assert.equal(manifest.schema, 2);
assert.equal(manifest.happId, "life.airen.vibedraw");
assert.ok(Number.isInteger(manifest.version.code) && manifest.version.code > 0);
assert.equal(manifest.display.orientation, "portrait", "VibeDraw must lock to portrait orientation");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const editorCss = fs.readFileSync(path.join(root, "styles/editor.css"), "utf8");
const componentsCss = fs.readFileSync(path.join(root, "styles/components.css"), "utf8");
const editorJs = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
const canvasJs = fs.readFileSync(path.join(root, "app/components/canvas.js"), "utf8");
const settingsJs = fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8");
const storeJs = fs.readFileSync(path.join(root, "app/services/store.js"), "utf8");
const uiJs = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
const imageEngineJs = fs.readFileSync(path.join(root, "app/services/image-engine.js"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app/app.js"), "utf8");
const assetsJs = fs.readFileSync(path.join(root, "app/services/assets.js"), "utf8");
const providersJs = fs.readFileSync(path.join(root, "app/services/providers.js"), "utf8");
const hermitJs = fs.readFileSync(path.join(root, "app/platform/hermit.js"), "utf8");
const renderPreviewJs = fs.readFileSync(path.join(root, "app/components/render-preview.js"), "utf8");
const galleryJs = fs.readFileSync(path.join(root, "app/components/gallery.js"), "utf8");
const runtimeJs = fs.readFileSync(path.join(root, "app/core/runtime.js"), "utf8");
const drawingJs = fs.readFileSync(path.join(root, "app/core/drawing.js"), "utf8");
assert.ok(html.includes('id="result-opacity"') && html.includes('id="result-visibility"'), "canvas bar must expose result opacity and visibility");
assert.ok(html.includes('id="choice-layer"') && html.includes('id="choice-options"'), "app must provide a shared in-app choice sheet");
assert.ok(!html.includes("<select") && !settingsJs.includes("<select") && !componentsCss.includes(".field select"), "app settings must not use native select menus");
assert.ok(settingsJs.includes("function bindChoices") && settingsJs.includes("ui.openChoice") && settingsJs.includes('select("theme"') && settingsJs.includes('select("language"'), "preference and model choices must use the shared choice sheet");
assert.ok(uiJs.includes("function openChoice") && uiJs.includes("choice-layer") && uiJs.includes("choice-option"), "choice sheet must render and handle its own option buttons");
assert.match(componentsCss, /\.choice-layer\{position:fixed;z-index:140;left:0;right:0;top:0;bottom:0\}/, "choice sheet must use Android WebView-compatible viewport bounds");
assert.ok(!html.includes('id="generation-strength"') && html.includes('id="seed-lock"'), "generation bar must remove the sketch-strength slider and retain seed rolling");
assert.ok(html.includes('id="overlay-toggle"') && html.includes('id="snapshot-canvas"'), "generation bar must expose overlay and snapshot controls");
assert.equal((html.match(/data-adjust="result/g) || []).length, 6, "canvas must expose six inline color adjustment sliders");
assert.ok(html.includes('id="color-adjust-panel"'), "color adjustments must live below the canvas");
assert.ok(html.includes('id="color-adjust-reset"') && html.includes('id="color-adjust-default"'), "color panel must expose reset and default actions");
assert.ok(html.includes('id="color-adjust-close"') && html.includes('id="color-adjust-enabled"'), "color panel must expose close and effect toggle actions");
assert.ok(html.includes('id="seed-value"') && !html.match(/id="seed-lock"[^>]*aria-pressed/), "dice must show the seed and must not be a lock switch");
assert.ok(html.indexOf('id="generate-quick"') < html.indexOf('id="seed-lock"') && html.indexOf('id="seed-lock"') < html.indexOf('id="generate-quality"'), "seed button must sit between Fast and Quality");
assert.ok(/id="generate-quality"[\s\S]*data-zh="渲染"/.test(html), "quality action must be presented as Render");
assert.ok(html.includes('id="render-preview"') && html.includes('id="render-preview-surface"') && html.includes('id="render-preview-adjust"') && html.includes('id="render-preview-adjustments"') && html.includes('id="render-preview-download"') && html.includes('id="render-preview-reset"') && html.includes('id="render-preview-clear"') && html.includes('id="render-preview-close"') && html.includes('id="render-preview-stage"') && html.includes('role="toolbar"'), "Render must have a fullscreen preview toolbox, adjustment panel, and image stage");
assert.equal((html.match(/data-render-adjust="result/g) || []).length, 4, "Render preview must expose the four live color adjustment sliders it keeps");
// The render panel lost brightness and contrast, lost its frosted translucent
// background, and gained the switch that decides whether its adjustments reach the
// picture at all. The switch is part of the same draft as the sliders: it starts from
// the saved render default, governs this preview, and is stored by save-default.
assert.ok(!/data-render-adjust="result(Brightness|Contrast)"/.test(html) && !renderPreviewJs.includes("adjustments.resultBrightness") && !renderPreviewJs.includes("adjustments.resultContrast"), "the render panel must not offer or apply brightness and contrast");
assert.match(html, /id="render-preview-adjust-enabled"[^>]*role="switch"/, "the action row must end in a switch for the color effect");
assert.ok(renderPreviewJs.includes("adjustmentsEnabled = effectsToggle.checked") && renderPreviewJs.includes("resultAdjustmentsEnabled: adjustmentsEnabled !== false") && renderPreviewJs.includes("config.canvas.resultAdjustmentsEnabled = adjustmentsEnabled !== false"), "the switch must reach the drawn pixels, the download, and save-default");
assert.ok(renderPreviewJs.includes("resultBrightness: NEUTRAL.resultBrightness") && renderPreviewJs.includes("resultContrast: NEUTRAL.resultContrast"), "brightness and contrast must stay neutral rather than becoming undefined filter terms");
// The panel and the toolbar are both dark glass: the backdrop is blurred and its
// brightness turned down, and what is written on them is white — labels, slider tracks
// and the hollow handle's outline. The canvas panel keeps its light-surface grey, which
// is why the slider colours are declared per panel instead of once for both.
// Asserting that *some* rule dims the glass is a trap: this file already shipped a
// later `.render-preview-tools{...brightness(1)!important}` that flattened the dimming
// back to 1, and the substring check stayed green the whole time. So read the cascade
// instead — take the last backdrop-filter that actually wins (deferring to !important,
// as the browser does) and require the dim there. Re-adding a trailing flatten rule
// turns this red, which is the whole point.
function winningBackdrop(css, selector) {
  const decls = css.split("}").map((chunk) => {
    const at = chunk.lastIndexOf("{");
    if (at < 0) return null;
    const sel = chunk.slice(0, at).split("{").pop().trim();
    return sel.split(",").some((part) => part.trim() === selector) ? chunk.slice(at + 1) : null;
  }).filter((decl) => decl && decl.indexOf("backdrop-filter:") >= 0);
  assert.ok(decls.length > 0, "expected at least one backdrop-filter rule for " + selector);
  const important = decls.filter((decl) => /backdrop-filter:[^;]*!important/.test(decl));
  const pool = important.length ? important : decls;
  return pool[pool.length - 1];
}
assert.match(winningBackdrop(componentsCss, ".render-preview-adjustments"), /brightness\(\.58\)/, "the adjustment panel must be dark glass with the backdrop brightness turned down");
assert.match(winningBackdrop(componentsCss, ".render-preview-tools"), /brightness\(\.58\)/, "the toolbar glass must be darkened the same way");
assert.ok(/\.render-preview-adjustments\{[^}]*background:rgba\(9,10,13,/.test(componentsCss) && /\.render-preview-tools\{[^}]*background:rgba\(9,10,13,/.test(componentsCss), "both preview glass surfaces must sit on the same dark tint");
assert.match(componentsCss, /\.render-preview-tools \.icon-button\{[^}]*color:#fff!important/, "the toolbar icons must be white on the dark glass");
assert.match(componentsCss, /\.render-preview-adjustments \.color-adjust-item>span,\.render-preview-adjustments \.color-adjust-item output\{color:#fff/, "the panel must write in white");
assert.ok(componentsCss.includes(".render-preview-adjustments .color-adjust-item input[type=range]::-webkit-slider-runnable-track{background:#fff}") && componentsCss.includes(".render-preview-adjustments .color-adjust-item input[type=range]::-webkit-slider-thumb{border-color:#fff") && componentsCss.includes(".render-preview-adjust-actions .button-secondary{background:rgba(255,255,255,.14)"), "the preview's track, its outlined handle and its secondary buttons must all be white");
assert.ok(componentsCss.includes(".color-adjust-item input[type=range]::-webkit-slider-runnable-track{background:#dfe3e9}") && componentsCss.includes(".color-adjust-item input[type=range]::-webkit-slider-thumb{width:18px;height:18px;margin-top:-7px;border:2px solid #c2c8d2"), "the canvas panel must keep its pale grey slider instead of inheriting the preview's white");
assert.ok(html.includes('id="render-preview-adjust-close"') && html.includes('id="render-preview-adjust-reset"') && html.includes('id="render-preview-adjust-default"'), "Render preview adjustments must expose close, reset, and save-default actions");
assert.ok(html.includes('id="prompt-display"') && html.includes('id="prompt-strength"') && html.includes('id="prompt-strength-default"') && html.includes('id="prompt-strength-value"') && html.includes('min="20" max="100"'), "Main prompt row must expose the image weight control bounded to 20-100%, its percentage, and the 80% shortcut");
assert.ok(editorJs.includes("var value = Math.max(20, Math.min(100, Math.round(Number(app.state.strength || 0.8) * 100)))") && editorJs.includes("value = Math.max(20, Math.min(100, Number(value) || 80)"), "the image weight control and its setter must share the 20-100% range declared by the markup");
assert.ok(componentsCss.includes(".advanced summary:focus{outline:none!important}") && !componentsCss.includes(".advanced summary:focus,.advanced summary:focus-visible"), "the summary focus rule must stay split: an unsupported selector listed beside :focus makes an old WebView drop the whole rule and draw the UA focus ring");
assert.ok(html.indexOf('id="render-preview-adjust-default"') < html.indexOf('id="render-preview-adjust-reset"') && html.indexOf('id="render-preview-adjust-reset"') < html.indexOf('id="render-preview-adjust-close"'), "Render preview adjustment actions must be save-default, reset, close");
assert.ok(!html.includes('id="render-preview-title"') && !html.includes('id="render-preview-meta"') && !html.includes('render-preview-footer'), "Render preview must not show title, resolution, or footer text");
assert.ok(html.includes('id="render-result-trigger"') && !html.includes('id="render-notice"'), "Render result must use only the animated diamond trigger");
assert.ok(editorJs.includes('detail.slot === "upscale"') && editorJs.includes('node("stage-busy").hidden = false'), "Render progress must show a non-blocking wait layer while the canvas remains editable");
assert.ok(editorJs.includes('syncRenderResult(true)') && editorJs.includes('trigger.hidden = true') && editorJs.includes('setTimeout(function ()'), "Repeated high-resolution renders must replay the diamond completion animation");
assert.ok(renderPreviewJs.includes('scale = Math.max(1, Math.min(8') && renderPreviewJs.includes('type: "pan"') && renderPreviewJs.includes('type: "pinch"'), "render preview must support bounded pan and pinch zoom");
assert.ok(renderPreviewJs.includes("createFrameTask(apply)"), "render preview transforms must be coalesced to animation frames");
// The description on the drawing screen used to be dragged sideways. It is a label
// with a tap target now: too long and it is clipped with an ellipsis, and a tap opens
// the dialog that edits it instead of scrolling it. Saving a changed description is a
// reason to draw again — the same path a brush stroke takes — and the sketch weight
// only counts once the finger is up, so it hangs off `change` rather than one `input`
// per pixel of the drag.
assert.match(editorCss, /\.prompt-readonly\{[^}]*flex:0 0 50%;[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap[^}]*\}/, "the description must take half the bar and be clipped with an ellipsis");
assert.match(editorCss, /\.prompt-strength\{[^}]*flex:1 1 0[^}]*\}/, "the sketch weight must fill the other half of the bar");
assert.ok(!editorJs.includes("promptDrag") && !editorJs.includes("scrollLeft") && !/\.prompt-readonly\{[^}]*overflow-x:auto/.test(editorCss) && !editorCss.includes(".prompt-readonly::-webkit-scrollbar"), "the horizontal scrolling design must be gone, not merely hidden");
assert.match(html, /id="prompt-display"[^>]*role="button"/, "the description must announce itself as something that can be opened");
// The pencil is an inline sibling of the description label, so the whole line — icon
// included — is one tap target. The failure mode this guards is silent: any code that
// writes the tap target's own textContent erases the icon on the next refresh, and a
// screenshot taken before that refresh would still look right.
assert.match(html, /id="prompt-display"[^>]*><i class="fa-solid fa-pen prompt-edit-icon" aria-hidden="true"><\/i><span[^>]*id="prompt-display-text"/, "the description must open with a pencil icon that sits before its label inside the same tap target");
assert.match(editorCss, /\.prompt-edit-icon\{[^}]*margin-right:5px;[^}]*font-size:10px;[^}]*vertical-align:middle/, "the pencil must be a small inline glyph at the start of the line");
assert.ok(editorJs.includes('node("prompt-display-text"), text =') && appJs.includes('getElementById("prompt-display-text").textContent = snapshot.prompt'), "both the refresh path and the restore path must fill the label inside the tap target");
assert.ok(!editorJs.includes('node("prompt-display").textContent') && !appJs.includes('getElementById("prompt-display").textContent'), "no code may write the tap target's own textContent, or the pencil disappears on the next refresh");
// The empty canvas opens with a pencil too. It used to carry a fountain-pen nib, which
// reads as a different tool than the one the app actually draws with.
assert.match(html, /id="stage-empty"><i class="fa-solid fa-pen"><\/i><strong/, "the empty canvas must open with a pencil rather than a fountain-pen nib");
assert.ok(!html.includes("fa-pen-nib"), "no fountain-pen nib may remain in the empty-canvas placeholder");
const promptEditorBody = editorJs.slice(editorJs.indexOf("function editPrompt"), editorJs.indexOf("function bindOptions"));
assert.ok(promptEditorBody.includes("data-cancel") && promptEditorBody.includes("data-save") && promptEditorBody.includes("app.state.prompt = next") && promptEditorBody.includes("app.services.imageEngine.schedule()"), "the description dialog must offer cancel and save, and a saved change must ask for a redraw");
assert.ok(promptEditorBody.indexOf('next === String(app.state.prompt || "").trim()') > 0 && promptEditorBody.indexOf('next === String(app.state.prompt || "").trim()') < promptEditorBody.indexOf("app.services.imageEngine.schedule()"), "an unchanged description must close without asking for a redraw");
assert.ok(editorJs.includes("display.onclick = editPrompt") && editorJs.includes('strength.addEventListener("change", function () { app.services.imageEngine.schedule(); })') && editorJs.includes('node("prompt-strength-default").onclick = function () { setPromptStrength(80); app.services.imageEngine.schedule(); }'), "a tap on the description and a released sketch-weight control must both schedule the automatic pass");
assert.ok(editorJs.includes("setPromptStrength(80)") && editorJs.includes("app.state.strength = value / 100"), "main image weight must share the canvas strength and provide an 80% shortcut");
assert.ok(editorJs.includes('node("prompt-strength-value").textContent = value + "%"') && editorCss.includes('.prompt-strength .icon-button{flex:0 0 24px') && editorCss.includes('margin:0 0 0 1px') && editorCss.includes('margin-left:3px'), "main image weight must use a borderless compact icon, tight gaps, and visible percentage");
assert.ok(renderPreviewJs.includes('document.getElementById("render-preview-download").onclick') && renderPreviewJs.includes('surface.toDataURL("image/png")') && renderPreviewJs.includes('result = result || current') && renderPreviewJs.includes('surfaceTask.request()') && renderPreviewJs.includes('saveAdjustmentsDefault'), "render preview download and adjustment actions must use the adjusted surface");
assert.ok(imageEngineJs.includes('if (slot === "upscale") config.inputMode = "sketch"') && imageEngineJs.includes('canvasInput.composeVisibleInput(referenceOptions)') && imageEngineJs.includes('dimensions.width !== wantWidth'), "Render must submit the visible canvas and require the configured square result");
assert.ok(providersJs.includes('id: "cvp"') && providersJs.includes("CVP_CAPABILITY") && providersJs.includes('base + "/cvp"') && providersJs.includes('api + "/jobs"') && providersJs.includes("image_base64") && providersJs.includes("mask_base64") && providersJs.includes("grow_mask_by") && providersJs.includes("ref_strength"), "the CVP format must submit the plugin's capabilities with a reference weight and a mask");
// A capability is named by its id, never by the model behind it: swapping the
// model must not require a new client. The plugin's own document is what tells
// the client what a capability accepts and which fields it ignores, so the
// client reads /cvp/info instead of assuming either.
assert.ok(providersJs.includes("capability: capability") && !/task: task,/.test(providersJs), "a job must be submitted under its capability id, not the retired task field");
assert.ok(providersJs.includes('"/cvp/info"') && providersJs.includes('cvpRemember') && providersJs.includes("capabilitySizes"), "testing the connection must read the plugin's information endpoint and keep what it says");
// A canvas is a pair, never one number. The plugin stopped publishing squares
// only in 2.3.0, so a client that keeps just the first number silently turns a
// portrait 768×1344 into a square 768 — a wrong shape with no error anywhere.
assert.ok(providersJs.includes("function cvpSizes") && providersJs.includes("return [Number(pair && pair[0]), Number(pair && pair[1])];"), "a published canvas must be carried as [width, height], not as its first number alone");
assert.ok(providersJs.includes("var canvas = sizes.length ? sizes[0] : null;") && providersJs.includes("value.width = canvas ? canvas[0]") && providersJs.includes("value.height = canvas ? canvas[1]"), "the CVP preset must take both edges of the first published canvas instead of mirroring one of them");
assert.ok(settingsJs.includes("data-aspect-width") && settingsJs.includes("data-aspect-height") && settingsJs.includes("draft[slot].height = Number(button.dataset.aspectHeight)"), "a canvas button must save both numbers, so choosing one cannot square a portrait canvas");
assert.ok(!settingsJs.includes("<strong>1:1</strong>"), "the locked aspect row must name the real shape, not assume every canvas is square");
assert.ok(providersJs.includes('"/jobs/" + encodeURIComponent(jobId) + "/progress"') && providersJs.includes("queue_position"), "the wait must poll the light progress call and may only count the queue");
assert.ok(providersJs.includes('if (!cvpIgnores(capability, "negative_prompt"))') && providersJs.includes("function cvpIgnores"), "a capability that declares a field ignored must not be sent it");
assert.ok(!providersJs.includes("detail.progress"), "a percentage must never be drawn from a progress response that does not carry one");
assert.ok(!providersJs.includes('id: "comfyui"') && !providersJs.includes("/view?filename=") && providersJs.includes("output.url"), "the retired workflow contract and the ComfyUI /view endpoint must be gone; the plugin serves its own images");
assert.ok(providersJs.includes("cvpStrength") && providersJs.includes("base * (value / 0.8)"), "the reference weight must scale from the per-task default while the artwork slider stays neutral at 80%");
assert.ok(settingsJs.includes("SLOT_TABS") && settingsJs.includes('["inpaint"') && settingsJs.includes("aspectField") && !settingsJs.includes("a1x") && !settingsJs.includes("a1x-profile"), "the model dialog must configure the three CVP tasks, show the locked aspect row, and carry no A1X preset");
assert.ok(!settingsJs.includes("app.config.quality"), "the retired quality slot must not be read by the settings dialog");
assert.match(componentsCss, /\.advanced summary:focus[^{]*\{outline:none/, "the advanced-options summary must not draw a focus ring");
assert.ok(!providersJs.includes("a1x") && !providersJs.includes("A1X"), "the A1X protocol implementation must be deleted from the provider layer, not just hidden from the menu");
assert.ok(providersJs.includes('name: "ComfyUI Vibedraw Plugin'), "the CVP format must be presented under its full ComfyUI Vibedraw Plugin name");
assert.ok(storeJs.includes("value.upscale = app.utils.merge") && storeJs.includes("value.inpaint = app.utils.merge") && storeJs.includes("value.schema = 8") && storeJs.includes('model.protocol === "a1x-image"') && storeJs.includes('model.protocol = "cvp"'), "schema 8 must split the two-model setup into the three tasks and fold the retired A1X and workflow formats into CVP");
assert.ok(storeJs.includes("function shareCvpConnection") && storeJs.includes('["quick", "inpaint", "upscale"].forEach') && storeJs.includes("model.endpoint = connection.endpoint") && storeJs.includes("var value = shareCvpConnection(app.utils.merge(app.defaults, config))"), "one CVP connection must be re-derived into every CVP task on load and on save, so editing it anywhere edits all three");
assert.ok(settingsJs.includes("var shared = draft.connection") && settingsJs.includes('var sharedField = cvp && ["endpoint", "apiKey", "customHeaders"].indexOf(field.name) >= 0') && settingsJs.includes("if (sharedField) shared[field.name] = value"), "the model dialog must read and write the one shared CVP connection while leaving the other formats alone");
assert.ok(settingsJs.includes("data-plugin-download") && settingsJs.includes("async function downloadPlugin") && settingsJs.includes("bridge.files.beginWrite(") && settingsJs.includes("bridge.files.appendBytes(") && settingsJs.includes("bridge.files.finishWrite(") && settingsJs.includes("bridge.files.export(") && settingsJs.includes('root.querySelector("[data-plugin-download]")') && settingsJs.includes("pluginButton.onclick = ui.action(downloadPlugin)"), "the CVP form must offer the bundled plugin through the host file writer and the system save dialog, not a download");
assert.ok(html.includes('src="./app/assets/comfyui-plugin.js"'), "the bundled plugin bytes must be part of the runtime script list");
const pluginBundleJs = fs.readFileSync(path.join(root, "app/assets/comfyui-plugin.js"), "utf8");
assert.ok(/app\.comfyuiPlugin = \{[\s\S]*name: "vibedraw-comfyui-plugin-v[0-9.]+\.zip"[\s\S]*base64:/.test(pluginBundleJs), "the generated asset must expose the archive name and its bytes");
assert.ok(pluginBundleJs.length > 20000 && !/\b(?:import|export)\s/.test(pluginBundleJs), "the embedded archive must carry real bytes and stay a plain script");
assert.ok(settingsJs.includes("function helpLine") && settingsJs.includes("function helpSection") && settingsJs.includes('class="help-icon"') && componentsCss.includes(".help-icon{box-sizing:border-box;flex:0 0 auto"), "every help line must lead with the tool's own icon");
// The sheet is a map of the toolbars, so the icons it prints must be the icons the
// toolbars paint. Asserting a few of them keeps a rewrite from quietly dropping them.
["pencil", "wand-magic-sparkles", "dice", "gear", "keyboard", "expand", "palette", "arrow-pointer", "object-group", "minus", "mask-face", "bolt", "camera", "download", "cubes"].forEach((name) => {
  assert.ok(settingsJs.includes('fa("fa-solid", "' + name + '")') || settingsJs.includes('fa("fa-regular", "' + name + '")'), "the help sheet must show the " + name + " icon");
});
assert.ok(settingsJs.includes('fa("fa-regular", "image")') && settingsJs.includes('fa("fa-regular", "gem")'), "the help sheet must show the image-weight and render icons in their regular cut");
// The whole point of the sheet is that a reader can find the button on screen, so no
// icon may be invented. Read every glyph the help body names and require the markup to
// actually paint it — the sheet once advertised pen-to-square, which no toolbar has.
{
  const helpBody = settingsJs.slice(settingsJs.indexOf("function help("), settingsJs.indexOf("function about("));
  const named = [...helpBody.matchAll(/fa\("fa-(?:solid|regular)", "([a-z0-9-]+)"\)/g)].map((match) => match[1]);
  assert.ok(named.length >= 15, "the help sheet must name the toolbar icons it explains");
  const invented = [...new Set(named)].filter((name) => !html.includes("fa-" + name));
  assert.equal(invented.join(","), "", "every icon the help sheet shows must exist in the markup: " + invented.join(", "));
  assert.ok(!helpBody.includes("pen-to-square"), "the prompt is edited in Artwork settings, so the sheet must not advertise a pen-to-square button that does not exist");
}
assert.ok(settingsJs.includes('<span class="mini-switch"></span>') && !/<ol>/.test(settingsJs.slice(settingsJs.indexOf("function help("), settingsJs.indexOf("function about("))), "the overlay switch must be shown as the real control, and the help must stay a list of short lines rather than prose paragraphs");
assert.ok(settingsJs.includes('var PROJECT_URL = "https://github.com/zhyuzh3d/vibedraw"') && settingsJs.includes('class="button button-secondary about-link" href="\' + PROJECT_URL + \'"') && !/<a [^>]*target=/.test(settingsJs), "the about sheet must link to the project in the same frame: this WebView has no window handler for a new tab");
assert.ok(componentsCss.includes(".about-link{width:100%;margin-top:16px;text-decoration:none}"), "the project link must read as a full-width button");
assert.ok(hermitJs.includes("var MESSAGE_CHARS = 200000") && hermitJs.includes("function checkBudget") && hermitJs.includes("checkBudget(options)") && hermitJs.includes("messageChars: MESSAGE_CHARS"), "the platform layer must keep every inline body inside the host message budget and expose that budget");
assert.ok(imageEngineJs.includes("mime: \"image/jpeg\"") && imageEngineJs.includes("maxBytes: Math.max(40000, (app.platform.hermit.messageChars || 200000) - reserved)") && imageEngineJs.includes("String(maskDataUrl || openAiMaskDataUrl || \"\").length + 8000"), "the reference image must be a budgeted JPEG that leaves room for the mask and the RPC envelope");
assert.ok(canvasJs.includes("async function composeWithinBudget") && canvasJs.includes("encoded.length > maxBytes") && canvasJs.includes("composeWithinBudget(composition, targetSize, options.withResult === true, options)"), "the canvas must step the reference size down until it fits the budget instead of relying on JPEG quality alone");
assert.ok(canvasJs.includes('async function exportVisibleCanvas()') && editorJs.includes('canvas.exportVisibleCanvas()') && !editorJs.includes('function exportOptions()'), "toolbar Download must directly export the visible canvas");
assert.match(editorJs, /seed-lock[\s\S]*generate-quick["']\)\.click\(\)/, "rolling a seed must trigger Fast generation");
assert.match(editorCss, /\.auto-button,\.generation-button\{[^}]*width:44px;height:44px;flex:0 0 44px/);
assert.match(editorCss, /\.seed-random-button,\.overlay-generate-button,\.snapshot-button,\.export-button\{[^}]*width:44px;height:44px;flex:0 0 44px/);
assert.ok(editorCss.includes('#brush-size-value{transform:translateX(-8px)}'), "stroke size output must sit 8px closer to its slider");
assert.ok(html.includes('id="prompt-display"') && !html.includes('id="prompt-input"') && !html.includes('id="prompt-save"'), "top prompt must be a read-only scrolling summary");
assert.match(editorCss, /\.prompt-panel\{[^}]*border:0;[^}]*background:transparent/);
assert.match(editorCss, /\.render-result-trigger\{[^}]*position:absolute;[^}]*right:8px;[^}]*bottom:8px;[^}]*width:34px;height:34px/);
assert.ok(!editorCss.includes(".render-notice"), "Render must not add a separate bottom notice bar");
assert.match(editorCss, /\.work-name span\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
assert.match(editorCss, /\.work-name\{[^}]*flex:0 1 auto;[^}]*max-width:calc\(100% - 112px\)/, "title button must size to its text so the pencil follows the title");
assert.ok(editorJs.includes('node("rename-work").onclick = rename'), "title and its pencil must share the rename action");
assert.ok(!editorJs.includes("app.state.prompt.slice") && !fs.readFileSync(path.join(root, "app/services/store.js"), "utf8").includes("snapshot.prompt.slice"), "prompt text must never become an artwork title");
assert.ok(!editorJs.includes('node("generation-strength")') && editorJs.includes('node("overlay-toggle")'), "editor must bind overlay instead of the removed strength slider");
assert.ok(settingsJs.includes('class="toggle-switch" name="overlayGenerate" type="checkbox" role="switch"'), "artwork overlay setting must use the common switch control");
assert.ok(canvasJs.includes("async function snapshotVisible()") && canvasJs.includes("renderComposition(composition, WIDTH, true)") && canvasJs.includes("width: WIDTH, height: WIDTH"), "snapshot must flatten the current visible layer order into a full-canvas image element");
assert.ok(canvasJs.includes("composition.layerOpacity") && canvasJs.includes("if (composition.overlayGenerate)") && canvasJs.includes("if (visibleSnapshot || composition.localMode) await drawCompositionResult"), "composition must place the result below translucent elements only in overlay mode, and keep the result as the local-redraw reference");
assert.ok(html.includes('id="mask-canvas"') && html.includes('id="mask-clear"') && html.includes('id="local-prompt"') && html.includes('id="local-prompt-edit"'), "local mode must own a mask layer, a clear action and its own description entry");
assert.ok(canvasJs.includes("function clearMask()") && canvasJs.includes("function maskStrokes()") && canvasJs.includes("localMode: masking") && canvasJs.includes("objects: masking ? [] : "), "local redraw must clear marks and submit the result without the element layer");
assert.ok(canvasJs.includes("maskContext.drawImage(maskContentCanvas, 0, 0)") && canvasJs.includes('object.tool === "mask" && maskPreview ? "#e5484d"'), "red marks must render on their own layer above the result");
assert.match(editorCss, /\.mask-canvas\{z-index:6;pointer-events:none\}/, "the mask layer must sit above the result layer and stay click-through");
assert.ok(editorJs.includes("function enterMaskMode()") && editorJs.includes("function exitMaskMode()") && !/function exitMaskMode\(\)[\s\S]{0,600}?canvas\.clearMask\(\)/.test(editorJs) && editorJs.includes('node("mask-clear").onclick'), "leaving local mode must hide the red marks but keep them for the next visit; only the broom clears them");
assert.ok(canvasJs.includes("function contentCount()") && canvasJs.includes("if (state.maskMode && state.maskVisible !== false) {\n        maskContext.drawImage(maskContentCanvas, 0, 0)"), "marks must stay off the canvas outside local mode, obey the mask switch, and never count as content");
assert.match(editorCss, /\.draw-options\.is-mask \.stroke-controls,\.draw-options\.is-eraser \.stroke-controls\{grid-template-columns:minmax\(0,1fr\);flex:1 1 50%/, "the area slider must span the full row inside local mode");
assert.match(editorCss, /\.draw-options\.is-mask #brush-size-value,\.draw-options\.is-eraser #brush-size-value\{transform:none;flex:0 0 auto;min-width:12px\}/, "the size value must hug the slider instead of sitting in a fixed 25px box");
assert.match(editorCss, /\.draw-options\.is-mask \.local-prompt-options\{flex:1 1 50%;margin-left:18px\}/, "the clear icon must keep a wider gap before a narrower description field");
assert.ok(imageEngineJs.includes('masking && (requested === "quick" || !requested) ? "inpaint"') && imageEngineJs.includes("canvasInput.composeMask(false)") && !imageEngineJs.includes('slot !== "quality" && canvasInput.hasMask()'), "an active mask must switch quick draw to the local-redraw task and submit the mask");
assert.ok(editorJs.includes("node(\"auto-toggle\").disabled = masking") && editorJs.includes("node(\"overlay-toggle\").disabled = masking") && editorJs.includes('node("background-color").hidden = maskMode'), "local mode must disable auto, overlay and the background control");
assert.ok(editorJs.includes("app.state.localPrompt") && editorJs.includes("hasResultImage()") && editorJs.includes("is-disabled"), "local mode must require a result and keep a separate description");
assert.ok(imageEngineJs.includes('app.utils.composePrompt("", app.state.localPrompt)') && !imageEngineJs.includes("composePrompt(app.state.prompt, masking ?") && imageEngineJs.includes("if (app.state.maskMode || !app.state.autoGenerate"), "a local redraw must submit the local description only, never the artwork-wide prompt, and skip auto generation");
// The prompt leaves exactly as it was written. Translating is the backend's
// job now: it owns the translator and its memory, it translates on submit when
// a text encoder needs English, and it reports what it did through the job's
// translated / prompt / prompt_source. A second mechanism here would be a
// second answer to the same fact, and the two would disagree eventually.
const engineRunBody = imageEngineJs.slice(imageEngineJs.indexOf("async function run("), imageEngineJs.indexOf("running = true; queuedSlot = \"\";"));
assert.ok(engineRunBody.includes("app.state.localPrompt") && engineRunBody.includes("app.state.negativePrompt") && engineRunBody.includes("app.state.prompt") && engineRunBody.includes("RENDER_PROMPT") && !engineRunBody.includes("english(") && !engineRunBody.includes("app.services.translate"), "the engine must hand over the prompt as written and take no part in translating it");
// The whole client-side translation mechanism is retired: the plugin does it on
// submit, so there is nothing here that could fall out of step with the plugin.
assert.ok(!/services\.translate|hasCjk|TRANSLATE_TAB|data-translate-now|translate\.probe/.test(settingsJs + editorJs + imageEngineJs + appJs + providersJs), "no client file may keep the retired translation mechanism");
assert.ok(!html.includes("translate.js") && !fs.existsSync(path.join(root, "app/services/translate.js")), "the retired translation service must be gone, not merely unused");
assert.ok(editorJs.includes("app.state.maskVisible = Number(event.target.value) >= 50") && editorJs.includes("app.state.maskVisible = app.state.maskVisible === false") && editorJs.includes('node("opacity-target-label").textContent = masking ? t("蒙版层显示（0 或 100）"'), "inside local redraw the eye and the slider must drive the mask layer only");
assert.ok(editorJs.includes('node("result-opacity").disabled = masking ? false') && editorJs.includes('visibility.disabled = masking ? false : !hasResult') && !editorJs.includes("成图固定不透明"), "local redraw must keep both controls usable and must never label the slider with the result opacity");
assert.ok(canvasJs.includes("function captureComposition(overrides)") && canvasJs.includes("options.withResult ? { localMode: true } : null") && imageEngineJs.includes("if (masking) referenceOptions.withResult = true"), "a local redraw must reference the decorated result on purpose instead of inheriting the mode flag");
const maskRecipeBody = canvasJs.slice(canvasJs.indexOf("function composeMask"), canvasJs.indexOf("async function exportSource"));
assert.ok(maskRecipeBody.includes('ctx.fillStyle = "black"') && !maskRecipeBody.includes("resultFilter") && !maskRecipeBody.includes("drawResult"), "the mask image must stay plain black and white: color adjustments must never reach it");
assert.ok(storeJs.includes('"resultVisible", "maskVisible"') && canvasJs.includes('"resultVisible", "maskVisible"'), "the mask switch must survive a reload like the other view toggles");
const enterMaskBody = editorJs.slice(editorJs.indexOf("function enterMaskMode"), editorJs.indexOf("function exitMaskMode"));
const exitMaskBody = editorJs.slice(editorJs.indexOf("function exitMaskMode"), editorJs.indexOf("function requestMaskTool"));
assert.ok(enterMaskBody.includes("syncCanvas()") && exitMaskBody.includes("syncCanvas()"), "entering and leaving local redraw must repaint the borrowed result controls instead of waiting for a canvas change");
const canvasExportBlock = (canvasJs.match(/return \{([\s\S]*?)\n  \};/g) || []).pop() || "";
const canvasExports = new Set([...canvasExportBlock.matchAll(/([A-Za-z0-9_]+):/g)].map((match) => match[1]));
const missingCanvasExports = [...new Set([...editorJs.matchAll(/(?:^|[^A-Za-z0-9_.])canvas\.([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]))].filter((name) => !canvasExports.has(name));
assert.ok(missingCanvasExports.length === 0, "every canvas method the editor calls must be exported by the canvas module: " + missingCanvasExports.join(", "));
assert.ok(html.includes("fa-solid fa-eraser") && html.includes("fa-solid fa-keyboard") && !html.includes("fa-broom") && !/color-control icon-control/.test(html), "clear marks and edit description must be bare icons (eraser and keyboard, no chip)");
assert.ok(editorCss.includes(".icon-control{display:grid;place-items:center;flex:0 0 27px;width:27px;height:27px;margin-left:4px;padding:0;border:0;background:transparent"), "row icons must be plain glyphs without a circle");
assert.ok(/\.local-prompt-button\{[^}]*border:0;background:transparent/.test(editorCss), "the local description must render without a box");
assert.ok(canvasJs.includes('marqueeOnDrag: Boolean(hit && hit.type === "image" && !hitAlreadySelected)') && canvasJs.includes('!selectionGesture.marqueeOnDrag'), "dragging from an unselected image must start a marquee instead of moving the image");
assert.ok(editorJs.includes('image.style.zIndex = overlay ? "1" : "4"') && editorJs.includes('animateActiveOpacity(0.66)'), "display mode must swap result layering and animate opacity to 66%");
assert.ok(editorJs.includes('app.state.layerOpacity = value') && editorJs.includes('app.state.resultOpacity = value'), "top opacity slider must target the active layer");
assert.match(editorJs, /snapshot-canvas[\s\S]*canvas\.snapshotVisible\(\)/);
assert.ok(html.includes('id="vibedraw-sharpen-matrix"'), "clarity must use a real sharpening convolution filter");
assert.ok(html.includes('id="canvas-fullscreen"') && html.includes('id="fullscreen-bottom"'), "fullscreen canvas controls must have fixed top and bottom anchors");
assert.ok(html.includes('id="fullscreen-tools-toggle"'), "fullscreen bottom tools must expose a collapse handle");
assert.ok(html.includes('id="modal-actions"'), "modal shell must provide an action area outside scrolling content");
assert.match(editorCss, /body\.canvas-fullscreen \.canvas-bar\{position:fixed;/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-bottom\{position:fixed;/);
assert.ok(!html.includes('id="canvas-action-help"') && !html.includes('id="tool-action-help"') && editorJs.includes('document.addEventListener("click"') && editorJs.includes('status(t(button.dataset.helpZh'), "all action help must use the shared status line");
assert.match(editorCss, /body\.canvas-fullscreen\.canvas-interacting \.fullscreen-bottom\{opacity:0;/);
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.fullscreen-bottom\{[^}]*background:none;[^}]*pointer-events:none/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-tools-toggle\{[^}]*top:36px;[^}]*width:48px;height:38px;[^}]*border-radius:9px 9px 0 0;[^}]*backdrop-filter:blur\(16px\)/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-bottom>\.drawing-dock\{[^}]*background:rgba[^}]*backdrop-filter:blur\(18px\)[^}]*contrast\(1\.24\)/, "fullscreen tools must use a translucent frosted-glass surface");
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.fullscreen-bottom>\.drawing-dock[^}]*display:none/);
// Collapsing the bottom tools must clear the top of the screen as well, and it has to be a
// real hide: the base rule sets `display:flex`, so anything short of `display:none` leaves an
// invisible bar that still swallows taps on the canvas behind it.
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.canvas-bar\{display:none\}/, "collapsing the bottom tools must take the top canvas bar with it");
assert.ok(!/fullscreen-tools-collapsed[^{]*\.canvas-bar\{[^}]*display:(?!none)/.test(editorCss), "no collapsed-state rule may put the top bar back on screen");
assert.ok(html.includes('data-en="Collapse the bottom tools and the top bar"'), "the collapse handle must say that it clears the top bar too");
assert.match(editorCss, /body\.canvas-fullscreen #canvas-fullscreen\{background:var\(--accent\);color:#fff/);
assert.ok(canvasJs.includes('app.events.emit("canvas:interaction"') && editorJs.includes('app.events.on("canvas:interaction"'), "fullscreen chrome must follow canvas interaction lifecycle");
assert.match(componentsCss, /\.modal-actions\{[^}]*flex:0 0 auto/);
assert.match(componentsCss, /\.work-settings-sheet\{height:88vh\}/);
assert.ok(settingsJs.includes('sheetClass: "work-settings-sheet"') && settingsJs.includes('footerHtml: footer(') && !settingsJs.includes('mode: "center", contentClass: "work-settings-content"'), "artwork settings must use a bottom sheet with external fixed actions");
assert.ok(!settingsJs.includes('range("colorStrength"') && settingsJs.includes('绘制稿保留强度'), "artwork settings must expose one preservation control without a separate color control");
assert.ok(canvasJs.includes('"colorStrength"'), "color strength must be restored with artwork canvas state");
assert.ok(html.includes('id="stroke-opacity"'), "drawing tools must expose direct stroke opacity");
assert.ok(html.includes('id="background-color"') && html.includes('<span aria-hidden="true">BG</span>') && editorCss.includes('.bg-control span{'), "background color control must show a centered BG label");
assert.ok(html.includes('id="status-line"') && (html.match(/data-help-zh=/g) || []).length >= 20 && editorJs.includes('function bindActionHelp()'), "canvas, drawing, and generation actions must explain their effect in the shared status line");
assert.ok(editorJs.includes('app.state.layerOpacity = 0.2') && editorJs.includes('Number(app.state.layerOpacity) < 0.2'), "Canvas interaction must restore a hidden overlay drawing layer to 20% visibility");
assert.ok(editorJs.includes('function animateResultOpacityFloor()') && editorJs.includes('duration = 500') && editorJs.includes('app.state.resultOpacity = from +'), "Fast and rolled-seed results must animate opacity back to 20% when hidden");
assert.match(editorCss, /\.stage-busy\{[^}]*pointer-events:none\}/, "Generation wait layer must pass pointer input through to the canvas");
assert.ok(componentsCss.includes(".render-preview{position:fixed;z-index:1000") && componentsCss.includes(".render-preview{position:fixed!important") && componentsCss.includes("width:100vw!important") && componentsCss.includes(".render-preview-stage{position:absolute!important;inset:0!important") && componentsCss.includes("height:100%!important") && componentsCss.includes(".render-preview-tools .icon-button+.icon-button{margin-left:10px!important}") && componentsCss.includes("background:transparent!important") && componentsCss.includes("backdrop-filter:blur(16px) saturate(1.1) brightness(.58)"), "fullscreen render preview must stay above app chrome with a fixed darkened toolbar");
// This device runs Chrome 83, which predates flex gap: a flex row spaced with `gap`
// silently collapses into touching children, which is exactly how the preview toolbar
// and the main prompt row shipped broken. Spacing in a flex row must be an adjacent
// sibling margin. Grid gap is fine and is left alone.
[["render preview toolbar", componentsCss, /\.render-preview-tools\{[^}]*gap:/], ["render preview prompt bar", componentsCss, /\.render-preview-promptbar\{[^}]*gap:/], ["render preview weight", componentsCss, /\.render-preview-weight\{[^}]*gap:/], ["main prompt row", editorCss, /\.prompt-panel\{[^}]*gap:/]].forEach(([label, css, pattern]) => {
  assert.ok(!pattern.test(css), label + " must space its flex children with a margin: this WebView drops flex gap");
});
assert.ok(componentsCss.includes(".render-preview-weight{margin-left:8px;width:calc(34% - 8px)}") && editorCss.includes("height:32px;margin-left:8px}"), "the preview weight box and the main weight control must claim their 8px through a margin");
assert.ok(componentsCss.includes(".render-preview-adjust-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-start;padding-top:4px}") && componentsCss.includes(".render-preview-adjust-actions .button{min-height:34px;padding:6px 15px;font-size:11.5px}"), "the adjustment actions must be left-aligned full-size buttons");
assert.ok(editorCss.includes("contrast(2) brightness(1)!important") && !componentsCss.includes("contrast(2) brightness(1)!important"), "the canvas fullscreen chrome keeps its high-contrast 2.0 glass; the render preview alone dims below 1, so no brightness(1) override may reappear there");
assert.ok(html.includes('class="fullscreen-pan-thumb"') && editorJs.includes("bindFullscreenPanToggle") && editorJs.includes("canvasPanLimit") && editorJs.includes("is-pan-scrollbar"), "Fullscreen toggle must support long-press horizontal canvas panning");
assert.ok(settingsJs.includes('range("colorOpacity"') && settingsJs.includes('object.opacity = opacity') && settingsJs.includes('app.state.opacity = opacity'), "color dialogs must apply opacity to the active stroke tool or selected strokes");
assert.match(componentsCss, /\.color-slider-stack \.field\{margin-bottom:5px\}/, "color sliders must use the compact vertical stack");
assert.ok(!html.includes('id="brush-more"'), "stroke opacity must not be hidden behind a modal button");
assert.ok(html.includes('id="selection-canvas"'), "selection chrome must have its own overlay");
assert.match(editorCss, /\.draft-canvas\{z-index:2;/);
assert.match(editorCss, /\.selection-canvas\{z-index:3;[^}]*pointer-events:none/);
assert.match(editorCss, /\.result-image\{z-index:4;[^}]*pointer-events:none;touch-action:none/);
assert.ok(!html.includes('id="stage-badge"'), "canvas must not show a preview badge");
assert.ok(runtimeJs.includes("function createFrameTask") && runtimeJs.includes("function createLru"), "runtime must provide shared frame scheduling and bounded caches");
assert.ok(drawingJs.includes("function cloneObjects") && drawingJs.includes("function estimateWeight"), "drawing data operations must avoid JSON cloning and support bounded history");
assert.ok(canvasJs.includes("contentCanvas") && canvasJs.includes("scheduleRender") && canvasJs.includes("HISTORY_MAX_WEIGHT"), "canvas must use cached content, frame scheduling, and bounded undo history");
// Generated images join the undo journal, so 120 consecutive generations must be
// 120 steps back. The journal carries the result by reference, is tagged by kind,
// and stays in memory: it is never part of an artwork record.
assert.ok(canvasJs.includes("var HISTORY_MAX_UNDO_STEPS = 120") && canvasJs.includes("var HISTORY_MAX_ENTRIES = HISTORY_MAX_UNDO_STEPS + 1") && canvasJs.includes("HISTORY_MAX_RESULT_CHARS"), "the undo journal must allow 120 steps, one entry per step plus the current state, with a bound on the images it holds");
assert.ok(canvasJs.includes("_resultChars: result && result.src") && canvasJs.includes('app.events.emit("result:changed")'), "a journal entry must carry the generated result, so one undo steps the result back to the previous image");
assert.ok(canvasJs.includes('function commitResult() { commitEntry("result"); }') && canvasJs.includes("next._kind = kind") && canvasJs.includes('{ schedule: undone._kind !== "result" }'), "a finished generation must be a journal step of its own, and undoing it must not immediately regenerate over the recovered image");
assert.ok(canvasJs.includes("state.result = data.result ? { src: data.result.src") && canvasJs.includes("logicalFileId: data.result.logicalFileId") && !/state\.result = data\.result \|\| null/.test(canvasJs), "stepping a result back must rebuild it without the stored file reference that the save-time cleanup reclaimed while it was history");
// Stepping the journal emits the change; something has to repaint the stage. With no
// listener the state is right and the screen is stale, which is exactly how a working
// undo looks broken, so the pairing is asserted rather than assumed.
assert.ok(canvasJs.includes('app.events.emit("result:changed")') && editorJs.includes('app.events.on("result:changed"'), "the result-changed notification must have a listener, or stepping the result back would leave the stage on the newer image");
assert.ok(editorJs.slice(editorJs.indexOf('app.events.on("result:changed"')).slice(0, 400).includes("syncCanvas()"), "the result-changed listener must repaint the stage");
const generationDoneBody = editorJs.slice(editorJs.indexOf('app.events.on("generation:done"'), editorJs.indexOf('app.events.on("generation:progress"'));
assert.ok(generationDoneBody.includes("canvas.commitResult()") && generationDoneBody.indexOf("canvas.commitResult()") > generationDoneBody.indexOf('result.slot === "upscale"'), "only a Fast or local-redraw result may join the undo journal; a render must stay out of it");
assert.ok(storeJs.includes("snapshot.render = storedImage(app.state.renderResult)") && storeJs.includes("if (copy.render && copy.render.asset)") && storeJs.includes("render: snapshot && snapshot.render") && storeJs.includes("render.asset = await app.services.assets.persist(render.src, null)"), "the last render must be saved with the artwork and read back from its files on load");
assert.ok(canvasJs.includes("state.renderResult = saved.render || null"), "loading an artwork must put its last render back into the state, or the saved render is unreachable");
assert.ok(assetsJs.includes("snapshot && snapshot.render ? [snapshot.render] : []"), "the asset cleanup must keep the files of the artwork's last render");
assert.ok(!/history/.test(storeJs), "the undo journal must stay in memory and never enter an artwork record");
// Layering a group. The old mutator opened with `selectionIds().length !== 1`, so a group
// (whose members all arrive selected at once) could not be layered at all, and the same
// single-object test armed the two arrows. Both halves have to move together or the arrow
// is live while the mutator ignores it, which looks exactly like a broken button.
const layerBody = canvasJs.slice(canvasJs.indexOf("function canMoveLayer"), canvasJs.indexOf("function scaleSelected"));
assert.ok(!layerBody.includes("length !== 1") && !layerBody.includes("selectionIds().length !=="), "layering must not require a single-object selection");
assert.ok(layerBody.includes("ids.has(state.objects[index + 1].id)") && layerBody.includes("ids.has(state.objects[index - 1].id)"), "each selected object must test the neighbour it is about to pass, which is what keeps a group from being split apart");
assert.ok(canvasJs.includes("canMoveLayer: canMoveLayer") && editorJs.includes('node("layer-down").disabled = !canvas.canMoveLayer(-1)') && editorJs.includes('node("layer-up").disabled = !canvas.canMoveLayer(1)'), "the arrows must be armed by the canvas's own predicate rather than by a second copy of the rule");
assert.ok(!editorJs.includes("canLayerDown") && !/ids\.length !== 1 \|\| selected/.test(editorJs), "the duplicated single-object arming rule must be gone from the editor");
assert.ok(!html.includes("把单个所选对象"), "the layer arrows must not keep promising that only a single object moves");
// Gallery thumbnails must reach the edges of the card. A card is wider than it is tall while
// the thumbnail is a square 288px bitmap, so containing the canvas left a pale band down both
// sides of every card — and the rendered image was contained inside that square as well,
// which put the same band one level further in. Both levels have to cover, or either one of
// them brings the bars back.
assert.match(componentsCss, /\.art-preview canvas\{[^}]*width:100%;height:100%;object-fit:cover/, "the gallery thumbnail must cover its card rather than leave side bands");
assert.ok(!/\.art-preview canvas\{[^}]*object-fit:contain/.test(componentsCss), "no rule may contain the gallery thumbnail again");
const coveredBody = canvasJs.slice(canvasJs.indexOf("function drawCovered"), canvasJs.indexOf("function drawImageObject"));
assert.match(coveredBody, /Math\.max\(/, "filling a frame means scaling by the larger of the two ratios");
assert.ok(!coveredBody.includes("Math.min("), "drawCovered must not quietly behave like drawContained");
const thumbnailBody = canvasJs.slice(canvasJs.indexOf("async function thumbnail"), canvasJs.indexOf("app.components.canvas = {"));
assert.ok(thumbnailBody.includes("drawCovered(ctx, result, size, size)") && !thumbnailBody.includes("drawContained(ctx, result"), "the thumbnail bitmap must fill its own square too, or a non-square render comes back as a band inside the card");
// The history card is drawn from the artwork's cover: the last generated picture, held as
// a reference into Hermit's file store. Reaching that needs four things at once, and
// dropping any one of them silently loses the card's image — the picture is filed when it
// arrives rather than at the next autosave, the record stores the reference, the thumbnail
// reads it first, and cleanup counts it among the artwork's references.
assert.ok(imageEngineJs.includes("await app.services.assets.coverFrom(generated)") && imageEngineJs.includes("app.state.cover = "), "a finished generation must be filed into Hermit's file store at once and become the document's cover");
assert.match(imageEngineJs, /else app\.state\.result = generated;[\s\S]*?coverFrom\(generated\)/, "the cover must be built from the very object the stage shows, so the card and the canvas can never disagree about which picture was generated last");
assert.match(storeJs, /snapshot\.cover = storedImage\(app\.state\.cover\)/, "the cover must be kept in the record as a reference, exactly like the result, never as bytes");
assert.ok(storeJs.includes("cover: snapshot && snapshot.cover ?"), "the cover must join the persisted-snapshot model too, or the saved cover keeps looking like a change that was never written");
assert.ok(storeJs.includes("copy.cover.src = await app.services.assets.resolve(copy.cover.asset)"), "restoring an artwork must resolve the cover's file reference");
const referencesBody = assetsJs.slice(assetsJs.indexOf("function references("), assetsJs.indexOf("async function cleanup("));
assert.ok(referencesBody.includes("snapshot.cover"), "cleanup must treat the cover as a reference, or the card's chunks are reclaimed the first time anything else about the artwork changes");
assert.ok(canvasJs.includes("state.cover = saved.cover || null"), "loading an artwork must bring its cover back, including one whose result was cleared");
assert.match(thumbnailBody, /if \(saved\.cover && saved\.cover\.asset\) \{[\s\S]*?if \(saved\.result && saved\.result\.asset\)/, "the card must try the cover before the result, for a cover is the newer picture by definition");
// The history list has to stay usable with a few hundred works, and on this host that is a
// limit problem twice over. Cards must arrive a page at a time, and covers must be fetched
// one at a time: firing the visible cards together made the device answer `Too many
// concurrent Hermit requests`, and `loadPreview` recorded that as a permanent error, so the
// affected cards stayed blank for good. Each half of the fix is asserted on its own, because
// losing either one brings the same blank cards back.
assert.ok(galleryJs.includes("list.slice(shown, shown + PAGE_SIZE)") && galleryJs.includes("PAGE_SIZE = 12"), "the gallery must build its grid a page at a time, not one innerHTML for every work");
assert.ok(!galleryJs.includes("grid.innerHTML = list.map") && galleryJs.includes("gallery-sentinel"), "the whole grid must never be rendered in one pass; the sentinel is what asks for the next page");
assert.match(componentsCss, /\.gallery-sentinel\{[^}]*height:1px/, "the sentinel must be a laid-out element the observer can watch");
const observerBody = galleryJs.slice(galleryJs.indexOf("function createPreviewObserver"), galleryJs.indexOf("function offScreen"));
assert.ok(observerBody.includes("enqueuePreview(") && !observerBody.includes("loadPreview("), "a card coming into view must join the queue rather than start a load of its own");
assert.ok(observerBody.includes('rootMargin: "180px 0px"'), "a cover may only be fetched once its card is near the viewport");
assert.equal(galleryJs.split("await loadPreview(").length, 2, "covers must be drawn from the single queue; a second caller would put the burst back");
assert.ok(!galleryJs.includes("worker(); worker();"), "the two-worker preview pool must stay gone");
assert.ok(galleryJs.includes("if (observer) observer.observe(card); else enqueuePreview(grid, item, token);"), "with no IntersectionObserver the fallback still has to reach the queue rather than draw on the spot");
assert.match(galleryJs, /for \(var attempt = 0; attempt < PREVIEW_ATTEMPTS/, "a failed cover must be retried, or a transient host collision leaves the card blank forever");
assert.ok(galleryJs.includes("MAX_LIVE_PREVIEWS") && galleryJs.includes("drawnPreviews.length > MAX_LIVE_PREVIEWS") && galleryJs.includes("target.width = 0"), "drawn covers must be given back past the cap, or a long list holds one bitmap per work");
assert.ok(galleryJs.includes("function offScreen(card)") && galleryJs.includes("drawnPreviews.filter(offScreen)[0]"), "only a cover that has scrolled away may be released, or the list redraws what the user is looking at");
assert.ok(html.includes("成图最多可回退 120 张") && html.includes("Up to 120 results can be stepped back"), "the undo help must state how far the generated-image journal reaches");
const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1]);
for (const reference of references) {
  if (reference.startsWith("/__hermit/") || reference.startsWith("data:")) continue;
  assert.ok(!/^https?:/i.test(reference), `runtime remote dependency: ${reference}`);
  assert.ok(fs.existsSync(path.join(root, reference.replace(/^\.\//, ""))), `missing reference: ${reference}`);
}

const scriptOrder = references.filter(value => value.endsWith(".js"));
assert.equal(scriptOrder[0], "./app/core/namespace.js");
assert.ok(scriptOrder.indexOf("./app/core/runtime.js") < scriptOrder.indexOf("./app/services/assets.js"));
assert.ok(scriptOrder.indexOf("./app/core/drawing.js") < scriptOrder.indexOf("./app/components/canvas.js"));
assert.equal(scriptOrder.at(-1), "./app/app.js");

const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|html|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}
walk(path.join(root, "app"));
walk(path.join(root, "styles"));
sourceFiles.push(path.join(root, "index.html"));

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  assert.ok(!/\b(?:import|export)\s+(?:\{|default|from)/.test(source), `ES module syntax in ${file}`);
  assert.ok(!/\?\.|\?\?|&&=|\|\|=/.test(source), `unsupported modern syntax in ${file}`);
  assert.ok(!/https?:\/\/(?:cdn|unpkg|jsdelivr)/i.test(source), `CDN dependency in ${file}`);
  if (file.endsWith(".js")) childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

childProcess.execFileSync(process.execPath, [path.join(root, "tests/providers.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/workspace.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/performance.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/assets.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/layer.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/cover.test.mjs")], { stdio: "inherit" });
if (!process.argv.includes("--source-only") && fs.existsSync(path.join(root, "hermit-install.json"))) {
  childProcess.execFileSync("python3", [path.join(root, "tools/package.py"), "--check"], { stdio: "inherit" });
}
console.log(`verify.mjs: ok (${sourceFiles.length} runtime files)`);
