import type { Project } from '../../../shared/types'
import { primaryAction, regionScope, screenFields, screenGoal, sortedModules, visibleRegions } from './flow'

/**
 * A clickable prototype, as one self-contained HTML file.
 *
 * The Markdown spec is a document you read; this is the same information as
 * something you walk through. Every screen's wireframe carries a hotspot over
 * each button, and the flow the user corrected on the canvas is what decides
 * where each hotspot goes.
 *
 * It has to open from `file://` with no network at all — that is both what makes
 * it easy to hand round and what keeps it honest about screenshots being
 * confidential. So: no CDN, no webfont, no framework, and every image inlined.
 */

interface ProtoHotspot {
  /** Percentages, so the overlay tracks the image at any window size. */
  x: number
  y: number
  w: number
  h: number
  label: string
  target: string | null
}

interface ProtoLink {
  trigger: string
  target: string
  crossModule: boolean
}

interface ProtoScreen {
  id: string
  moduleId: string
  name: string
  goal: string
  entry: boolean
  terminal: boolean
  image: string
  fields: { name: string; from: string }[]
  hotspots: ProtoHotspot[]
  links: ProtoLink[]
  contains: string
}

export function toPrototypeHtml(project: Project, images: Record<string, string>): string {
  const modules = sortedModules(project)
  const nodeById = new Map(project.flow.nodes.map((node) => [node.id, node]))
  const screenNodes = project.flow.nodes.filter((node) => node.kind !== 'note')
  const entry = screenNodes.find((node) => node.entry) ?? screenNodes[0]

  const screens: ProtoScreen[] = screenNodes.map((node) => {
    const wireframe = node.screenId ? project.wireframes[node.screenId] : undefined
    const links: ProtoLink[] = project.flow.edges
      .filter((edge) => edge.source === node.id && nodeById.has(edge.target))
      .map((edge) => ({
        trigger: edge.trigger || 'Continues',
        target: edge.target,
        crossModule: Boolean(edge.crossModule)
      }))

    const hotspots: ProtoHotspot[] = []
    if (wireframe && wireframe.width && wireframe.height) {
      const regions = visibleRegions(project, node.screenId, wireframe.regions)
      for (const region of regions) {
        if (region.kind !== 'button') continue
        const label = (region.text ?? '').replace(/\s+/g, ' ').trim()
        if (!label) continue
        const match = links.find((link) => link.trigger.toLowerCase().includes(label.toLowerCase()))
        hotspots.push({
          x: (region.x / wireframe.width) * 100,
          y: (region.y / wireframe.height) * 100,
          w: (region.w / wireframe.width) * 100,
          h: (region.h / wireframe.height) * 100,
          label,
          target: match?.target ?? null
        })
      }
    }

    // A terminal screen has no button regions at all — its transitions are the
    // PF keys, which reach the reader as actions rather than as shapes. The
    // action list in the detail panel is how those are walked.
    const scope = regionScope(project, node.screenId)
    const contains = wireframe
      ? visibleRegions(project, node.screenId, wireframe.regions)
          .map((region) => region.kind)
          .filter((kind, index, all) => all.indexOf(kind) === index)
          .join(' · ')
      : node.kind === 'stub'
        ? 'not designed yet'
        : 'not generated yet'

    return {
      id: node.id,
      moduleId: node.moduleId,
      name: node.label,
      goal: screenGoal(project, node.screenId),
      entry: Boolean(node.entry),
      terminal: Boolean(wireframe?.terminal),
      image: (node.screenId && images[node.screenId]) || '',
      fields: screenFields(project, node.screenId).map((field) => ({
        name: field.name,
        from: field.from
      })),
      hotspots,
      links,
      contains: scope.header && scope.footer ? contains : `${contains} (header/footer scoped)`
    }
  })

  const data = {
    name: project.name,
    entry: entry?.id ?? '',
    modules: modules.map((module) => ({ id: module.id, name: module.name, color: module.color })),
    screens,
    // The primary action per screen, so the detail panel can lead with it.
    primary: Object.fromEntries(
      screenNodes.map((node) => [node.id, primaryAction(project, node.screenId)?.label ?? ''])
    )
  }

  // `</` inside a script tag would close it early, whatever the JSON says.
  const payload = JSON.stringify(data).replace(/<\//g, '<\\/')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(project.name)} — clickable prototype</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <strong>${escapeHtml(project.name)}</strong>
  <span class="sub" id="crumb"></span>
  <span class="grow"></span>
  <button id="back" title="Go back (Backspace)">Back</button>
  <button id="restart" title="Jump to the entry screen">Restart</button>
  <label class="peek"><input type="checkbox" id="peek" /> Show hotspots</label>
</header>
<main>
  <nav id="rail"></nav>
  <section class="stage">
    <div class="frame" id="frame"></div>
  </section>
  <aside id="detail"></aside>
</main>
<script type="application/json" id="flowdata">${payload}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

const STYLE = `
:root{--bg:#14161b;--panel:#1a1d24;--line:#2b303a;--ink:#e7e9ee;--dim:#8b93a3;--accent:#37C2CE;--warn:#F2A65A}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.top{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.top .sub{color:var(--dim);font-size:12px}
.grow{flex:1}
button{background:#232833;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}
button:hover{border-color:var(--accent)}
button:disabled{opacity:.4;cursor:default}
.peek{font-size:12px;color:var(--dim);display:flex;align-items:center;gap:5px;cursor:pointer}
main{display:grid;grid-template-columns:230px 1fr 280px;height:calc(100vh - 49px)}
nav{border-right:1px solid var(--line);overflow:auto;padding:12px 0;background:var(--panel)}
nav h4{margin:14px 14px 6px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
nav h4 i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle}
nav a{display:block;padding:6px 14px;color:var(--ink);text-decoration:none;font-size:13px;border-left:2px solid transparent;cursor:pointer}
nav a:hover{background:#20242d}
nav a.on{border-left-color:var(--accent);background:#20242d}
nav a .entry{color:var(--accent);font-size:10px;margin-left:5px}
.stage{overflow:auto;display:flex;justify-content:center;padding:24px}
.frame{position:relative;align-self:flex-start;max-width:100%}
.frame img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px}
.hot{position:absolute;border-radius:4px;cursor:pointer;border:2px solid transparent;background:transparent}
.hot.live:hover{border-color:var(--accent);background:rgba(55,194,206,.16)}
.hot.dead{cursor:not-allowed}
.hot.dead:hover{border-color:var(--warn);background:rgba(242,166,90,.14)}
body.peeking .hot.live{border-color:rgba(55,194,206,.75);background:rgba(55,194,206,.1)}
body.peeking .hot.dead{border-color:rgba(242,166,90,.6);border-style:dashed}
aside{border-left:1px solid var(--line);overflow:auto;padding:16px;background:var(--panel)}
aside h3{margin:0 0 4px;font-size:15px}
aside .goal{color:var(--accent);font-size:12px;margin:0 0 14px}
aside h5{margin:16px 0 6px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
aside ul{margin:0;padding:0;list-style:none}
aside li{padding:4px 0;border-bottom:1px solid #23272f;font-size:13px}
aside li span{color:var(--dim);font-size:11px;margin-left:6px}
aside .go{display:block;width:100%;text-align:left;margin:4px 0}
.miss{color:var(--dim);font-size:12px;font-style:italic}
.placeholder{width:520px;height:340px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:4px;color:var(--dim)}
@media (max-width:900px){main{grid-template-columns:1fr}nav,aside{display:none}}
`

const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('flowdata').textContent);
  var byId = {};
  data.screens.forEach(function (s) { byId[s.id] = s; });
  var history = [];
  var current = data.entry;

  var rail = document.getElementById('rail');
  var frame = document.getElementById('frame');
  var detail = document.getElementById('detail');
  var crumb = document.getElementById('crumb');
  var back = document.getElementById('back');

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildRail() {
    data.modules.forEach(function (module) {
      var screens = data.screens.filter(function (s) { return s.moduleId === module.id; });
      if (!screens.length) return;
      var head = el('h4');
      var swatch = el('i');
      swatch.style.background = module.color;
      head.appendChild(swatch);
      head.appendChild(document.createTextNode(module.name));
      rail.appendChild(head);
      screens.forEach(function (s) {
        var link = el('a', '', s.name);
        link.dataset.id = s.id;
        if (s.entry) link.appendChild(el('span', 'entry', 'START'));
        link.addEventListener('click', function () { go(s.id, true); });
        rail.appendChild(link);
      });
    });
  }

  function go(id, push) {
    if (!byId[id]) return;
    if (push && current && current !== id) history.push(current);
    current = id;
    render();
  }

  function render() {
    var screen = byId[current];
    if (!screen) return;
    frame.innerHTML = '';
    detail.innerHTML = '';

    if (screen.image) {
      var img = new Image();
      img.src = screen.image;
      img.alt = screen.name;
      frame.appendChild(img);
      screen.hotspots.forEach(function (spot) {
        var hot = el('button', 'hot ' + (spot.target ? 'live' : 'dead'));
        hot.style.left = spot.x + '%';
        hot.style.top = spot.y + '%';
        hot.style.width = spot.w + '%';
        hot.style.height = spot.h + '%';
        hot.title = spot.target
          ? spot.label + ' → ' + byId[spot.target].name
          : spot.label + ' — not wired to anything yet';
        if (spot.target) hot.addEventListener('click', function () { go(spot.target, true); });
        frame.appendChild(hot);
      });
    } else {
      frame.appendChild(el('div', 'placeholder', 'No wireframe for this screen yet'));
    }

    detail.appendChild(el('h3', '', screen.name));
    if (screen.goal) detail.appendChild(el('p', 'goal', screen.goal));
    detail.appendChild(el('p', 'miss', screen.contains));

    if (screen.fields.length) {
      detail.appendChild(el('h5', '', 'Fields'));
      var list = el('ul');
      screen.fields.forEach(function (field) {
        var item = el('li', '', field.name);
        if (field.from === 'position') item.appendChild(el('span', '', 'unnamed'));
        else if (field.from === 'placeholder') item.appendChild(el('span', '', 'from the control'));
        list.appendChild(item);
      });
      detail.appendChild(list);
    }

    detail.appendChild(el('h5', '', 'Where you can go'));
    if (screen.links.length) {
      screen.links.forEach(function (link) {
        var button = el('button', 'go', link.trigger + ' → ' + byId[link.target].name);
        button.addEventListener('click', function () { go(link.target, true); });
        detail.appendChild(button);
      });
    } else {
      detail.appendChild(el('p', 'miss', 'Nothing leaves this screen.'));
    }

    Array.prototype.forEach.call(rail.querySelectorAll('a'), function (a) {
      a.classList.toggle('on', a.dataset.id === current);
    });
    crumb.textContent = screen.name + (screen.terminal ? ' · terminal screen' : '');
    back.disabled = !history.length;
  }

  back.addEventListener('click', function () {
    var previous = history.pop();
    if (previous) { current = previous; render(); }
  });
  document.getElementById('restart').addEventListener('click', function () {
    history = [];
    go(data.entry, false);
  });
  document.getElementById('peek').addEventListener('change', function (event) {
    document.body.classList.toggle('peeking', event.target.checked);
  });
  document.addEventListener('keydown', function (event) {
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 'Backspace' || event.key === 'ArrowLeft') {
      event.preventDefault();
      back.click();
    }
  });

  buildRail();
  render();
})();
`
