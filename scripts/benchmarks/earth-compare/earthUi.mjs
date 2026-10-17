/**
 * Public Earth UI preparation; no private app properties, storage or traffic.
 * Official instructions checked 2026-10-17:
 * https://developers.google.com/maps/documentation/earth/basemap-settings
 * Clean removes map labels. Satellite, 3D buildings and animated clouds have
 * separate controls. These helpers still need qualification against live UI;
 * public selection evidence does not establish camera or image-mask parity.
 */
import { evaluate } from "../../lib/headlessChrome.mjs";

const source = "https://developers.google.com/maps/documentation/earth/basemap-settings";
const checkedOn = "2026-10-17";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Exposed DOM and open shadow roots only. Target identity follows native label
// associations or one native input inside an ARIA radio/checkbox/switch.
// Private class names and implementation properties are never consulted.
const dom = `
  const all=[],seen=new Set();
  function visit(root){for(const e of root.querySelectorAll('*')){if(seen.has(e))continue;seen.add(e);all.push(e);if(e.shadowRoot)visit(e.shadowRoot);}}
  visit(document);
  const text=value=>String(value??'').replace(/\\s+/g,' ').trim();
  const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
  const parent=e=>e.parentElement??e.getRootNode?.()?.host??null;
  const intersect=(a,b)=>({x:Math.max(a.x,b.x),y:Math.max(a.y,b.y),width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y))});
  const beneath=(child,ancestor)=>{let node=child,depth=0;while(node&&depth++<128){if(node===ancestor)return true;node=parent(node);}return false;};
  function rendered(e){const r=rect(e);if(!(r.width>0&&r.height>0))return false;let node=e,depth=0;
    while(node&&depth++<128){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.contentVisibility==='hidden'||Number(s.opacity)===0||node.hidden===true)return false;node=parent(node);}
    return node===null;}
  const accessible=e=>{let node=e,depth=0;while(node&&depth++<128){if(node.getAttribute?.('aria-hidden')==='true')return false;node=parent(node);}return node===null;};
  function effects(style,prefix){const warnings=[];
    for(const name of['transform','perspective','clipPath','maskImage','webkitMaskImage','filter','backdropFilter','webkitBackdropFilter'])if(style[name]&&style[name]!=='none')warnings.push(prefix+':'+name);
    if(style.clip&&style.clip!=='auto')warnings.push(prefix+':clip');
    if(style.opacity!==undefined&&style.opacity!==''&&Number(style.opacity)!==1)warnings.push(prefix+':opacity');
    if(style.zoom&&style.zoom!=='normal'&&Number(style.zoom)!==1)warnings.push(prefix+':zoom');
    if(style.mixBlendMode&&style.mixBlendMode!=='normal')warnings.push(prefix+':mixBlendMode');
    if(style.contentVisibility&&style.contentVisibility!=='visible')warnings.push(prefix+':contentVisibility');
    if(/(?:^|\\s)(paint|strict|content)(?:$|\\s)/.test(style.contain??''))warnings.push(prefix+':paint-containment');
    return warnings;}
  function geometry(e){const bounds=rect(e),ownStyle=getComputedStyle(e),ancestors=[],geometryWarnings=effects(ownStyle,'canvas-or-element');
    if([ownStyle.borderTopWidth,ownStyle.borderRightWidth,ownStyle.borderBottomWidth,ownStyle.borderLeftWidth,ownStyle.paddingTop,ownStyle.paddingRight,ownStyle.paddingBottom,ownStyle.paddingLeft].some(value=>Number.parseFloat(value)>0))geometryWarnings.push('canvas-or-element:border-or-padding');
    if([ownStyle.borderTopLeftRadius,ownStyle.borderTopRightRadius,ownStyle.borderBottomLeftRadius,ownStyle.borderBottomRightRadius].some(value=>Number.parseFloat(value)>0))geometryWarnings.push('canvas-or-element:rounded-content');
    if(ownStyle.objectFit&&ownStyle.objectFit!=='fill')geometryWarnings.push('canvas-or-element:object-fit');
    if(ownStyle.contentVisibility&&ownStyle.contentVisibility!=='visible')geometryWarnings.push('canvas-or-element:content-visibility');
    let clipped=intersect(bounds,{x:0,y:0,width:innerWidth,height:innerHeight}),node=parent(e),depth=0;
    while(node&&depth++<128){const s=getComputedStyle(node),r=rect(node),clipX=/^(hidden|clip|scroll|auto)$/.test(s.overflowX),clipY=/^(hidden|clip|scroll|auto)$/.test(s.overflowY);
      geometryWarnings.push(...effects(s,'ancestor'));
      if(clipX||clipY){ancestors.push({tag:node.tagName,rect:r,overflowX:s.overflowX,overflowY:s.overflowY});
        if([s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth].some(value=>Number.parseFloat(value)>0))geometryWarnings.push('ancestor:bordered-overflow-clip');
        if([s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius].some(value=>Number.parseFloat(value)>0))geometryWarnings.push('ancestor:rounded-overflow-clip');
        clipped=intersect(clipped,{x:clipX?r.x:clipped.x,y:clipY?r.y:clipped.y,width:clipX?r.width:clipped.width,height:clipY?r.height:clipped.height});}node=parent(node);}
    if(node!==null)geometryWarnings.push('ancestor-traversal-limit');
    return{rect:bounds,clippedRect:clipped,clippingAncestors:ancestors,geometryWarnings:[...new Set(geometryWarnings)]};}
  const visible=e=>{if(!rendered(e))return false;const r=geometry(e).clippedRect;return r.width>0&&r.height>0;};
  function labels(e){const values=[e.getAttribute('aria-label'),e.getAttribute('title')];
    if(['BUTTON','INPUT','METER','OUTPUT','PROGRESS','SELECT','TEXTAREA'].includes(e.tagName)&&e.labels)for(const label of e.labels)values.push(label.innerText??label.textContent);
    for(const id of(e.getAttribute('aria-labelledby')??'').split(/\\s+/).filter(Boolean)){const root=e.getRootNode?.(),label=root?.getElementById?.(id)??document.getElementById?.(id);if(label)values.push(label.innerText??label.textContent);}
    values.push(e.innerText??e.textContent);return[...new Set(values.map(text).filter(Boolean))];}
  const roles=new Set(['button','radio','checkbox','switch','option','menuitem','menuitemradio','menuitemcheckbox']);
  const control=e=>['BUTTON','INPUT','OPTION','LABEL','SUMMARY'].includes(e.tagName)||roles.has(e.getAttribute('role'));
  function targetOf(e){if(e.tagName==='LABEL'&&e.control)return e.control;
    if(['radio','checkbox','switch'].includes(e.getAttribute('role'))){const inputs=all.filter(other=>other.tagName==='INPUT'&&['radio','checkbox'].includes(other.type)&&beneath(other,e));if(inputs.length===1)return inputs[0];}
    return e;}
  function declarations(e){const values=[];for(const name of['aria-checked','aria-selected','aria-pressed']){const v=e.getAttribute(name);if(v==='true'||v==='false')values.push(v==='true');else if(v!==null)values.push(null);}
    if(e.tagName==='INPUT'&&['radio','checkbox'].includes(e.type))values.push(e.checked);
    if(e.tagName==='OPTION')values.push(e.selected);return values;}
  function disabled(e){let node=e,depth=0;while(node&&depth++<128){if((['BUTTON','INPUT','SELECT','TEXTAREA','FIELDSET','OPTGROUP','OPTION'].includes(node.tagName)&&node.disabled===true)||node.inert===true||node.getAttribute?.('aria-disabled')==='true'||node.getAttribute?.('disabled')!==null)return true;node=parent(node);}return node!==null;}
  const names={basemap:['Basemap settings','Basemap'],clean:['Clean','Clean No borders, labels, places, or roads.','Clean No borders, labels, places, or roads'],
    satellite:['Satellite'],buildings:['3D buildings','3D buildings and trees'],clouds:['Animated clouds'],more:['More visuals'],dismiss:['Dismiss']};
  function groups(name,onlyVisible=true){const matches=all.filter(e=>control(e)&&accessible(e)&&(onlyVisible?visible(e):rendered(e))&&labels(e).some(label=>names[name].some(value=>label.toLowerCase()===value.toLowerCase()))),groups=new Map();
    for(const e of matches){const target=targetOf(e);if(!groups.has(target))groups.set(target,{target,elements:[]});groups.get(target).elements.push(e);}return[...groups.values()];}
  function groupState(group){const members=[...new Set([group.target,...group.elements])],states=members.flatMap(declarations),unique=new Set(states);
    return{checked:unique.size===1&&typeof states[0]==='boolean'?states[0]:null,stateConflict:unique.size>1,disabled:members.some(disabled),
      labels:[...new Set(group.elements.flatMap(labels))],role:group.target.getAttribute('role')??group.target.tagName.toLowerCase(),rect:geometry(group.elements[0]).clippedRect};}
  function evidence(name){const found=groups(name);return{count:found.length,availableCount:groups(name,false).length,elementCount:found.reduce((sum,g)=>sum+g.elements.length,0),states:found.map(groupState)};}
`;

/** Public diagnostic for a live probe; no controls are activated. */
export async function inspectEarthUi(chrome, sessionId) {
  return evaluate(chrome, sessionId, `(()=>{${dom}return Object.fromEntries(Object.keys(names).map(name=>[name,evidence(name)]));})()`);
}

async function reveal(chrome, sessionId, name) {
  return evaluate(chrome, sessionId, `(()=>{${dom}const found=groups(${JSON.stringify(name)},false);
    if(found.length!==1)return{revealed:false,reason:found.length?'ambiguous-control':'control-unavailable'};
    found[0].elements[0].scrollIntoView({block:'nearest',inline:'nearest'});return{revealed:true};})()`);
}

async function click(chrome, sessionId, name, desiredState) {
  return evaluate(chrome, sessionId, `(()=>{${dom}const found=groups(${JSON.stringify(name)}),available=groups(${JSON.stringify(name)},false);
    if(found.length!==1||available.length!==1)return{clicked:false,reason:available.length>1?'ambiguous-control':'control-unavailable'};
    const state=groupState(found[0]);if(state.disabled)return{clicked:false,reason:'disabled-control'};
    ${desiredState === undefined ? "" : `if(state.stateConflict||state.checked!==${JSON.stringify(!desiredState)})return{clicked:false,reason:'state-unknown-conflicting-or-already-selected'};`}
    if(typeof document.elementFromPoint!=='function')return{clicked:false,reason:'hit-test-unavailable'};
    const r=geometry(found[0].elements[0]).clippedRect,x=r.x+r.width/2,y=r.y+r.height/2;
    let hit=document.elementFromPoint(x,y),depth=0;
    while(hit?.shadowRoot&&typeof hit.shadowRoot.elementFromPoint==='function'&&depth++<32){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
    if(!hit||![found[0].target,...found[0].elements].some(e=>beneath(hit,e)||targetOf(hit)===found[0].target))return{clicked:false,reason:'control-occluded-at-centre'};
    found[0].elements[0].click();return{clicked:true};})()`);
}

async function basemapShortcut(chrome, sessionId) {
  const key = { key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 };
  await chrome.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, sessionId);
  await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sessionId);
}

function selected(snapshot, name, desired = true) {
  const entry = snapshot?.[name], controls = entry?.states;
  return entry?.count === 1 && (entry.availableCount === undefined || entry.availableCount === 1) && controls?.length === 1 && controls[0].checked === desired
    && controls[0].stateConflict !== true && controls[0].disabled !== true;
}

/** Different controls sharing a name are ambiguous even when both are checked. */
export function earthPolicyReasons(snapshot) {
  const reasons = [];
  for (const [name, label] of [["clean", "Clean details"], ["satellite", "Satellite basemap"], ["buildings", "3D buildings"]]) {
    if (!selected(snapshot, name)) reasons.push(`${label} is not uniquely confirmed selected by public control state`);
  }
  if (!selected(snapshot, "clouds", false)) reasons.push("Animated clouds are not uniquely confirmed disabled by public control state");
  return reasons;
}

/**
 * Canvas geometry, clipping and sampled hit-test occlusion are separate facts.
 * A toolbar drawn over a canvas must not be mistaken for a shorter canvas.
 * Hit tests are sparse evidence; labels drawn inside a canvas remain unknown.
 */
export async function earthRenderInfo(chrome, sessionId) {
  return evaluate(chrome, sessionId, `(()=>{${dom}
    const viewport={width:innerWidth,height:innerHeight,devicePixelRatio};
    const describe=e=>({tag:e.tagName,role:e.getAttribute?.('role')??(control(e)?e.tagName.toLowerCase():null),labels:labels(e).slice(0,3).map(value=>value.slice(0,160)),rect:geometry(e).clippedRect});
    function atPoint(x,y){if(typeof document.elementFromPoint!=='function')return null;let e=document.elementFromPoint(x,y),depth=0;
      while(e?.shadowRoot&&typeof e.shadowRoot.elementFromPoint==='function'&&depth++<32){const next=e.shadowRoot.elementFromPoint(x,y);if(!next||next===e)break;e=next;}return e;}
    const canvases=all.filter(e=>e.tagName==='CANVAS').map((e,index)=>{const g=geometry(e),style=getComputedStyle(e),r=g.clippedRect;
      const occlusionSamples=[];if(visible(e))for(const fy of[.1,.3,.5,.7,.9])for(const fx of[.1,.3,.5,.7,.9]){const x=r.x+r.width*fx,y=r.y+r.height*fy,hit=atPoint(x,y);
        occlusionSamples.push({x,y,status:hit===e?'canvas':hit===null?'unknown':hit.tagName==='CANVAS'?'other-canvas':'overlay',...(hit&&hit!==e?{hit:describe(hit)}:{})});}
      return{index,backingWidth:e.width,backingHeight:e.height,...g,visible:visible(e),transform:style.transform??'none',clipPath:style.clipPath??'none',occlusionSamples};});
    const ui=all.filter(e=>(control(e)||['dialog','tooltip','toolbar','status','navigation','alert'].includes(e.getAttribute('role')))&&visible(e));
    const uiRects=ui.slice(0,250).map(describe);
    return{viewport,canvases,uiRects,uiRectsTruncated:ui.length>250,occlusionProbeAvailable:typeof document.elementFromPoint==='function',
      limitations:['Sparse DOM hit tests do not prove the absence of visual overlays.','Text and animation drawn inside a canvas need screenshot review.']};})()`);
}

/**
 * Opens documented public controls and checks every selection. A deadline
 * limits UI polling/actions; individual CDP commands retain transport timeouts.
 * Unknown controls return unverified, and any panel opened here is closed in
 * finally. The caller still owns camera, viewport and screenshot-mask review.
 */
export async function prepareEarth(chrome, sessionId, { timeoutMs = 15000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError("timeoutMs must be within 1..120000");
  const deadline = Date.now() + timeoutMs, reasons = [], actions = [];
  let evidence = null, renderInfo = null, panelOpened = false, panelClosed = false, attemptedOpen = false;
  const read = async () => { evidence = await inspectEarthUi(chrome, sessionId); return evidence; };
  const wait = async predicate => {
    for (;;) {
      if (predicate(await read())) return true;
      if (Date.now() >= deadline) return false;
      await pause(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  };
  const expose = async name => {
    await read();
    if (evidence[name]?.count > 0) return true;
    if (Date.now() >= deadline || evidence[name]?.availableCount !== 1) return false;
    const result = await reveal(chrome, sessionId, name); actions.push({ action: `reveal-${name}`, ...result });
    return result.revealed && wait(value => value[name]?.count > 0);
  };
  const ensure = async (name, desired) => {
    if (Date.now() >= deadline || !await expose(name)) return false;
    if (selected(evidence, name, desired)) return true;
    const result = await click(chrome, sessionId, name, desired); actions.push({ action: `${desired ? "select" : "disable"}-${name}`, ...result });
    return result.clicked && wait(value => selected(value, name, desired));
  };
  try {
    await read();
    if (!await wait(value => value.basemap?.availableCount > 0 || value.clean?.availableCount > 0)) reasons.push("Earth's public basemap control was unavailable before the preparation deadline");
    else {
      if (evidence.dismiss?.count === 1) {
        actions.push({ action: "dismiss-tooltip", ...await click(chrome, sessionId, "dismiss") });
        await read();
      } else if (evidence.dismiss?.count > 1) reasons.push("Startup Dismiss controls are ambiguous");
      if (!evidence.clean?.availableCount) {
        attemptedOpen = true;
        await expose("basemap");
        const result = await click(chrome, sessionId, "basemap"); actions.push({ action: "open-basemap", ...result });
        if (!result.clicked && Date.now() < deadline) { await basemapShortcut(chrome, sessionId); actions.push({ action: "documented-ctrl-b" }); }
      }
      panelOpened = await wait(value => value.clean?.availableCount > 0);
      if (!panelOpened) reasons.push("Basemap settings did not expose an identifiable Clean control before the deadline");
      else {
        for (const name of ["satellite", "buildings", "clean"]) if (!await ensure(name, true)) reasons.push(`Could not uniquely confirm ${name} selected`);
        await read();
        let moreOpened = false;
        if (!evidence.clouds?.availableCount && Date.now() < deadline && await expose("more")) {
          const result = await click(chrome, sessionId, "more"); actions.push({ action: "open-more-visuals", ...result }); moreOpened = result.clicked;
          if (result.clicked) await wait(value => value.clouds?.availableCount > 0);
        }
        await ensure("clouds", false);
        const cloudEvidence = evidence?.clouds;
        // Re-read each map setting after editing clouds; stale pre-edit state
        // cannot prove that another public control kept its value.
        if (moreOpened && Date.now() < deadline) {
          if (await expose("more")) actions.push({ action: "close-more-visuals", ...await click(chrome, sessionId, "more") });
        }
        const finalEvidence = {};
        for (const name of ["satellite", "buildings", "clean"]) {
          await expose(name); finalEvidence[name] = evidence?.[name];
        }
        // Cloud state was measured after its last action and no later action
        // changes a map setting. Retain it if scrolling moved it out of view.
        evidence = { ...evidence, ...finalEvidence, clouds: cloudEvidence };
        reasons.push(...earthPolicyReasons(evidence));
      }
    }
  } catch (error) { reasons.push(`Public UI preparation failed: ${error.message}`); }
  finally {
    if (panelOpened || attemptedOpen) {
      try {
        const beforeClose = await inspectEarthUi(chrome, sessionId);
        if (beforeClose.clean?.availableCount > 0 || beforeClose.clouds?.availableCount > 0) {
          await basemapShortcut(chrome, sessionId);
          // Panel transitions can outlast a protocol response. Cleanup gets a
          // short independent deadline even when preparation itself timed out.
          const closeDeadline = Date.now() + Math.min(1000, timeoutMs);
          do {
            const after = await inspectEarthUi(chrome, sessionId);
            panelClosed = after.clean?.availableCount === 0 && after.clouds?.availableCount === 0;
            if (panelClosed || Date.now() >= closeDeadline) break;
            await pause(50);
          } while (true);
        } else panelClosed = true;
        if (!panelClosed) reasons.push("Basemap settings did not confirm closed");
      } catch (error) { reasons.push(`Could not close basemap settings: ${error.message}`); }
    }
    try { renderInfo = await earthRenderInfo(chrome, sessionId); }
    catch (error) { reasons.push(`Canvas measurement failed: ${error.message}`); }
  }
  if (!renderInfo?.canvases?.some(canvas => canvas.visible && canvas.backingWidth > 0 && canvas.backingHeight > 0)) reasons.push("No visible backed canvas was confirmed");
  return { policyVerified: reasons.length === 0 && panelOpened && panelClosed, reasons, evidence, actions, renderInfo,
    source, checkedOn, requiresCameraAndMaskReview: true };
}
