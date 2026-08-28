import type {
  FlowEdge,
  FlowNode,
  Module,
  NamedField,
  Project,
  Region,
  ScreenAsset
} from '../../../shared/types'
import { KIND_LABEL, regionSummary } from './wireframe'

const COLUMN_WIDTH = 430
const MODULE_ROW_HEIGHT = 330

/** The user's own name for a screen, then the one read off it, then the file name. */
function titleFor(screen: ScreenAsset, project?: Project): string {
  const chosen = screen.title?.trim()
  if (chosen) return chosen.slice(0, 48)

  const captured = project?.wireframes[screen.id]?.title?.trim()
  if (captured && captured.length > 2) return captured.slice(0, 48)

  return (
    screen.name
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, (c) => c.toUpperCase()) || 'Screen'
  )
}

/** The name to show for a screen anywhere in the app or an export. */
export function screenName(project: Project, screenId: string | undefined): string {
  const screen = screenId ? project.screens.find((item) => item.id === screenId) : undefined
  return screen ? titleFor(screen, project) : 'Screen'
}

/** What the user is trying to do here — their own words, else a guess from the actions. */
export function screenGoal(project: Project, screenId: string | undefined): string {
  const screen = screenId ? project.screens.find((item) => item.id === screenId) : undefined
  const chosen = screen?.goal?.trim()
  if (chosen) return chosen

  const forward = primaryAction(project, screenId)
  if (!forward) return ''
  const label = forward.label.trim()
  if (!label) return ''
  return /^[a-z]/.test(label) ? label.replace(/^./, (c) => c.toUpperCase()) : label
}

/** The fields found on a screen, with the user's renames applied. */
export function screenFields(project: Project, screenId: string | undefined): NamedField[] {
  if (!screenId) return []
  const derived = project.wireframes[screenId]?.fields ?? []
  const renames = project.screens.find((item) => item.id === screenId)?.fieldNames
  if (!renames) return derived
  return derived.map((field) =>
    renames[field.key] ? { ...field, name: renames[field.key] } : field
  )
}

/** Whether this screen's header and footer are in scope, project default included. */
export function regionScope(
  project: Project,
  screenId: string | undefined
): { header: boolean; footer: boolean } {
  const screen = screenId ? project.screens.find((item) => item.id === screenId) : undefined
  return {
    header: screen?.include?.header ?? project.generate.includeHeader,
    footer: screen?.include?.footer ?? project.generate.includeFooter
  }
}

/**
 * The regions in scope for this screen.
 *
 * Every consumer of a region list goes through here, because excluding the
 * header has to mean the same thing in the drawing, the spec, the prototype and
 * the model's context. The regions themselves stay on the wireframe, so the
 * toggle never costs a regeneration.
 */
export function visibleRegions(
  project: Project,
  screenId: string | undefined,
  regions: Region[]
): Region[] {
  const scope = regionScope(project, screenId)
  if (scope.header && scope.footer) return regions
  return regions.filter((region) => {
    if (region.kind === 'header') return scope.header
    if (region.kind === 'footer') return scope.footer
    return true
  })
}

/** Screen-backed nodes only. Notes and stubs are not screens. */
function screenNodes(nodes: FlowNode[]): FlowNode[] {
  return nodes.filter((node) => node.kind !== 'note')
}

export function sortedModules(project: Project): Module[] {
  return [...project.modules].sort((a, b) => a.order - b.order)
}

export function screensInModule(project: Project, moduleId: string): ScreenAsset[] {
  return project.screens
    .filter((screen) => screen.moduleId === moduleId)
    .sort((a, b) => a.order - b.order)
}

/**
 * Builds the first draft of the flow. Each module is a lane: its screens chain in
 * the order they were added, and the last screen of one module hands off to the
 * first screen of the next, so the whole product reads as one path while each
 * module stays separately designable.
 *
 * Positions and edges the user has already moved or drawn are kept.
 */
export function draftFlow(project: Project): { nodes: FlowNode[]; edges: FlowEdge[] } {
  // Only screen-backed nodes are keyed by screen. A note has no screen, and
  // keying it by `undefined` would make every note collide on one key.
  const existing = new Map(
    project.flow.nodes
      .filter((node) => node.screenId)
      .map((node) => [node.screenId as string, node])
  )
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []

  const kept = new Map(project.flow.edges.map((edge) => [edge.id, edge]))
  const manualPairs = new Set(
    project.flow.edges.filter((edge) => edge.manual).map((edge) => `${edge.source}>${edge.target}`)
  )
  const modules = sortedModules(project)
  let previousModuleTail: FlowNode | null = null

  modules.forEach((module, lane) => {
    const screens = screensInModule(project, module.id)
    const laneNodes: FlowNode[] = screens.map((screen, index) => {
      const prior = existing.get(screen.id)
      return {
        id: prior?.id ?? `n_${screen.id}`,
        screenId: screen.id,
        moduleId: module.id,
        label: prior?.label ?? titleFor(screen, project),
        x: prior && (prior.x || prior.y) ? prior.x : index * COLUMN_WIDTH,
        y: prior && (prior.x || prior.y) ? prior.y : lane * MODULE_ROW_HEIGHT,
        // The screen the user marked with SET stays marked. Re-draft used to
        // reset it to the first screen of the first module every time.
        entry: prior?.entry ?? false,
        kind: prior?.kind === 'stub' ? 'stub' : 'screen'
      }
    })

    for (let i = 0; i < laneNodes.length - 1; i += 1) {
      // A connection the user drew between these two already says what happens.
      if (manualPairs.has(`${laneNodes[i].id}>${laneNodes[i + 1].id}`)) continue
      edges.push(
        makeEdge(project, laneNodes[i], laneNodes[i + 1], kept, false, guessTrigger(project, laneNodes[i].screenId))
      )
    }

    if (previousModuleTail && laneNodes.length) {
      if (!manualPairs.has(`${previousModuleTail.id}>${laneNodes[0].id}`)) {
        edges.push(
          makeEdge(project, previousModuleTail, laneNodes[0], kept, true, `Enters ${module.name}`)
        )
      }
    }
    if (laneNodes.length) previousModuleTail = laneNodes[laneNodes.length - 1]
    nodes.push(...laneNodes)
  })

  // Notes and stubs are the user's own; carry them through untouched.
  const known = new Set(project.modules.map((module) => module.id));
  const fallbackModule = sortedModules(project)[0]?.id ?? ''
  for (const node of project.flow.nodes) {
    if (node.screenId) continue
    nodes.push({
      ...node,
      moduleId: known.has(node.moduleId) ? node.moduleId : fallbackModule,
      entry: false
    })
  }

  // Keep any connection the user drew by hand that still points at live nodes.
  const nodeIds = new Set(nodes.map((node) => node.id))
  const drafted = new Set(edges.map((edge) => edge.id))
  for (const edge of project.flow.edges) {
    if (drafted.has(edge.id)) continue
    // Where the user has drawn their own transition between two screens, that
    // is the transition. A draft left over from a previous run between the same
    // pair would otherwise ride along beside it, one more copy per re-draft.
    if (!edge.manual && manualPairs.has(`${edge.source}>${edge.target}`)) continue
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) edges.push(edge)
  }

  // Exactly one entry point, and never a sticky note.
  const candidates = nodes.filter((node) => node.kind !== 'note')
  const marked = candidates.filter((node) => node.entry)
  if (marked.length > 1) for (const node of marked.slice(1)) node.entry = false
  if (!marked.length && candidates.length) candidates[0].entry = true

  return { nodes, edges }
}

function makeEdge(
  project: Project,
  from: FlowNode,
  to: FlowNode,
  kept: Map<string, FlowEdge>,
  crossModule: boolean,
  trigger: string
): FlowEdge {
  const id = `e_${from.id}_${to.id}`
  const prior = kept.get(id)
  return {
    id,
    source: from.id,
    target: to.id,
    trigger: prior?.trigger ?? trigger,
    crossModule
  }
}

/** The action that most likely moves a user on from this screen. */
export function primaryAction(
  project: Project,
  screenId: string | undefined
): { key: string; label: string } | null {
  if (!screenId) return null
  const actions = project.wireframes[screenId]?.actions ?? []
  const ranked = actions
    .map((action, index) => ({ action, rank: action.rank ?? 1, index }))
    .filter((item) => item.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked[0]?.action ?? null
}

function guessTrigger(project: Project, screenId: string | undefined): string {
  if (!screenId) return 'Continues'
  const wireframe = project.wireframes[screenId]
  if (!wireframe) return 'Continues'

  // When the screen's own words were read, name the control the user presses.
  const forward = primaryAction(project, screenId)
  if (forward) {
    if (wireframe.terminal) {
      return forward.key === 'ENTER'
        ? 'Presses ENTER'
        : `Presses ${forward.key} (${forward.label})`
    }
    return `Taps ${forward.label}`
  }

  // No words: the shapes on the screen are all there is to go on. Only the
  // regions in scope count, so a footer nobody wants does not name the step.
  const kinds = new Set(
    visibleRegions(project, screenId, wireframe.regions).map((region) => region.kind)
  )
  if (wireframe.terminal) {
    if (kinds.has('field')) return 'Fills the fields and presses ENTER'
    if (kinds.has('table')) return 'Types an option beside a row'
    return 'Presses ENTER'
  }
  if (kinds.has('input')) return 'Submits the form'
  if (kinds.has('button')) return 'Taps the primary button'
  if (kinds.has('list')) return 'Selects an item'
  if (kinds.has('nav')) return 'Uses the nav'
  return 'Continues'
}

/** Every screen reachable from the entry node, in visit order. */
export function walkFlow(flow: { nodes: FlowNode[]; edges: FlowEdge[] }): FlowNode[] {
  const entry = flow.nodes.find((node) => node.entry) ?? flow.nodes[0]
  if (!entry) return []
  const byId = new Map(flow.nodes.map((node) => [node.id, node]))
  const order: FlowNode[] = []
  const seen = new Set<string>()
  const queue = [entry.id]

  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (!node) continue
    order.push(node)
    for (const edge of flow.edges) if (edge.source === id) queue.push(edge.target)
  }
  return order
}

/** Nodes no edge can reach from the entry point — the dead ends worth flagging. */
export function unreachableNodes(flow: { nodes: FlowNode[]; edges: FlowEdge[] }): FlowNode[] {
  const reachable = new Set(walkFlow(flow).map((node) => node.id))
  // A sticky note is not a screen a user can fail to reach.
  return screenNodes(flow.nodes).filter((node) => !reachable.has(node.id))
}

export function danglingNodes(flow: { nodes: FlowNode[]; edges: FlowEdge[] }): FlowNode[] {
  return screenNodes(flow.nodes).filter(
    (node) => !flow.edges.some((edge) => edge.source === node.id)
  )
}

// ------------------------------------------------------------------ export

export function toMermaid(project: Project, moduleId?: string): string {
  const modules = sortedModules(project).filter((module) => !moduleId || module.id === moduleId)
  const visible = new Set(
    project.flow.nodes
      .filter((node) => modules.some((module) => module.id === node.moduleId))
      .map((node) => node.id)
  )

  const lines = ['flowchart LR']
  for (const module of modules) {
    lines.push(`  subgraph ${module.id}["${escapeMermaid(module.name)}"]`)
    for (const node of project.flow.nodes.filter((item) => item.moduleId === module.id)) {
      lines.push(`    ${node.id}${mermaidShape(node)}`)
    }
    lines.push('  end')
  }
  for (const edge of project.flow.edges) {
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue
    const arrow = edge.crossModule ? '==>' : '-->'
    lines.push(`  ${edge.source} -- ${escapeMermaid(edge.trigger || 'next')} ${arrow} ${edge.target}`)
  }
  return lines.join('\n')
}

/** A note is a remark, a stub is a screen that does not exist yet, the rest are screens. */
function mermaidShape(node: FlowNode): string {
  const label = escapeMermaid(node.label)
  if (node.kind === 'note') return `>${label}]`
  if (node.kind === 'stub') return `{{${label}}}`
  return node.entry ? `([${label}])` : `[${label}]`
}

function escapeMermaid(text: string): string {
  return text.replace(/["[\]{}|]/g, ' ').trim() || 'Screen'
}

/** The hand-off document: each module as its own workflow, then the whole path. */
export function toMarkdownSpec(project: Project): string {
  const screensById = new Map(project.screens.map((screen) => [screen.id, screen]))
  const modules = sortedModules(project)
  const orphans = unreachableNodes(project.flow)
  const out: string[] = []

  out.push(`# ${project.name}`, '')
  out.push(`_Flow spec generated by FlowFrame on ${new Date().toLocaleString()}._`, '')
  out.push(
    `${modules.length} module${modules.length === 1 ? '' : 's'} · ` +
      `${project.screens.length} screen${project.screens.length === 1 ? '' : 's'} · ` +
      `${Object.keys(project.wireframes).length} wireframed · ` +
      `${project.flow.edges.length} transition${project.flow.edges.length === 1 ? '' : 's'}.`,
    ''
  )

  out.push('## Whole product', '', '```mermaid', toMermaid(project), '```', '')

  for (const module of modules) {
    const all = project.flow.nodes.filter((node) => node.moduleId === module.id)
    const nodes = all.filter((node) => node.kind !== 'note')
    const notes = all.filter((node) => node.kind === 'note')
    out.push(`## Module: ${module.name}`, '')
    if (!all.length) {
      out.push('_No screens in this module yet._', '')
      continue
    }

    out.push('```mermaid', toMermaid(project, module.id), '```', '')
    out.push('### Steps', '')
    nodes.forEach((node, index) => {
      const outgoing = project.flow.edges.filter((edge) => edge.source === node.id)
      out.push(`${index + 1}. **${node.label}**${node.entry ? ' — product entry point' : ''}`)
      const goal = screenGoal(project, node.screenId)
      if (goal) out.push(`   - Goal: ${goal}`)
      const wireframe = node.screenId ? project.wireframes[node.screenId] : undefined
      if (wireframe) {
        const regions = visibleRegions(project, node.screenId, wireframe.regions)
        out.push(`   - Contains: ${regionSummary(regions) || 'no regions detected'}`)
        if (wireframe.terminal) out.push('   - Type: 3270 / 5250 terminal screen')
        const fields = screenFields(project, node.screenId)
        if (fields.length) {
          out.push(`   - Fields: ${fields.map((field) => field.name).join(', ')}`)
        }
        if (wireframe.actions?.length) {
          out.push(
            `   - Actions: ${wireframe.actions
              .map((action) => (action.key === action.label ? action.label : `${action.key} = ${action.label}`))
              .join(', ')}`
          )
        }
      } else if (node.kind === 'stub') {
        out.push('   - Not designed yet: this screen is a placeholder in the flow.')
      }
      const screen = node.screenId ? screensById.get(node.screenId) : undefined
      if (screen) out.push(`   - Source: \`${screen.name}\` (${screen.width}×${screen.height})`)
      for (const edge of outgoing) {
        const target = project.flow.nodes.find((candidate) => candidate.id === edge.target)
        const targetModule = modules.find((candidate) => candidate.id === target?.moduleId)
        const suffix =
          target && target.moduleId !== module.id ? ` _(into ${targetModule?.name ?? 'another module'})_` : ''
        out.push(`   - ${edge.trigger || 'Continues'} → **${target?.label ?? 'unknown'}**${suffix}`)
      }
      if (!outgoing.length) out.push('   - Exit point: nothing leaves this screen.')
      out.push('')
    })

    if (notes.length) {
      out.push('### Notes on the flow', '')
      for (const note of notes) {
        out.push(`- **${note.label}**${note.body ? ` — ${note.body.replace(/\s+/g, ' ').trim()}` : ''}`)
      }
      out.push('')
    }
  }

  if (orphans.length) {
    out.push('## Screens nobody can reach', '')
    for (const node of orphans) {
      const module = modules.find((candidate) => candidate.id === node.moduleId)
      out.push(`- **${node.label}** (${module?.name ?? 'no module'}) has no path from the entry point.`)
    }
    out.push('')
  }

  // This section is a verbatim transcript of the screen, not a scoped view, so
  // it deliberately ignores the header/footer toggle. Do not "fix" it.
  const captured = project.flow.nodes.filter(
    (node) => node.screenId && project.wireframes[node.screenId]?.text
  )
  if (captured.length) {
    out.push('## What each screen says', '')
    out.push('_Read off the screenshots themselves, so this document works without the images._', '')
    for (const node of captured) {
      const wireframe = project.wireframes[node.screenId!]!
      out.push(`### ${node.label}`, '', '```', wireframe.text!.trim(), '```', '')
    }
  }

  out.push('## Screen inventory', '')
  out.push('| Module | Screen | Regions found | Wireframed |')
  out.push('| --- | --- | --- | --- |')
  for (const module of modules) {
    for (const screen of screensInModule(project, module.id)) {
      const wireframe = project.wireframes[screen.id]
      const regions = wireframe
        ? regionSummary(visibleRegions(project, screen.id, wireframe.regions))
        : '—'
      out.push(`| ${module.name} | ${screen.name} | ${regions} | ${wireframe ? 'yes' : 'no'} |`)
    }
  }
  out.push('')

  return out.join('\n')
}

/** Compact context handed to the model so it can answer about the real flow. */
export function flowContext(project: Project, moduleId?: string): string {
  const modules = sortedModules(project).filter((module) => !moduleId || module.id === moduleId)
  const lines = [`Project: ${project.name}`, `Screens: ${project.screens.length}`]

  for (const module of modules) {
    lines.push(`\nModule "${module.name}":`)
    const nodes = project.flow.nodes.filter((node) => node.moduleId === module.id)
    if (!nodes.length) {
      lines.push('- (no screens yet)')
      continue
    }
    for (const node of nodes) {
      if (node.kind === 'note') {
        lines.push(`- (note) ${node.label}${node.body ? `: ${node.body}` : ''}`)
        continue
      }
      const wireframe = node.screenId ? project.wireframes[node.screenId] : undefined
      if (!wireframe) {
        lines.push(
          `- ${node.label}${node.entry ? ' (entry)' : ''}: ` +
            (node.kind === 'stub' ? 'a screen the flow needs that does not exist yet' : 'not generated yet')
        )
        continue
      }
      const regions = visibleRegions(project, node.screenId, wireframe.regions)
        .map((region) => KIND_LABEL[region.kind])
        .join(', ')
      lines.push(
        `- ${node.label}${node.entry ? ' (entry)' : ''}` +
          `${wireframe.terminal ? ' [3270/5250 terminal screen]' : ''}: ${regions}`
      )
      const goal = screenGoal(project, node.screenId)
      if (goal) lines.push(`  goal: ${goal}`)
      const fields = screenFields(project, node.screenId)
      if (fields.length) lines.push(`  fields: ${fields.map((field) => field.name).join(', ')}`)
      if (wireframe.actions?.length) {
        lines.push(
          `  actions: ${wireframe.actions.map((action) => `${action.key}=${action.label}`).join(', ')}`
        )
      }
      // The words on the screen are what makes a text-only model useful here.
      if (wireframe.text) {
        const excerpt = wireframe.text.split('\n').slice(0, 24).join(' | ').slice(0, 900)
        lines.push(`  text: ${excerpt}`)
      }
    }
  }

  const visible = new Set(
    project.flow.nodes
      .filter((node) => modules.some((module) => module.id === node.moduleId))
      .map((node) => node.id)
  )
  const edges = project.flow.edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target)
  )
  if (edges.length) {
    lines.push('\nTransitions:')
    for (const edge of edges) {
      const from = project.flow.nodes.find((node) => node.id === edge.source)?.label ?? edge.source
      const to = project.flow.nodes.find((node) => node.id === edge.target)?.label ?? edge.target
      lines.push(`- ${from} --[${edge.trigger}]--> ${to}${edge.crossModule ? ' (module hand-off)' : ''}`)
    }
  }
  return lines.join('\n')
}
