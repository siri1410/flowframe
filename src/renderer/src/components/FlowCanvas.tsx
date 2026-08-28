import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { AlertTriangle, Plus, Redo2, Route, StickyNote, Undo2, Wand2 } from 'lucide-react'
import { danglingNodes, primaryAction, sortedModules, unreachableNodes } from '../lib/flow'
import { useStore } from '../state/store'

type ScreenNodeData = {
  label: string
  step: number
  entry: boolean
  image?: string
  nodeId: string
  moduleName: string
  color: string
  stub: boolean
}

type NoteNodeData = {
  label: string
  body: string
  nodeId: string
  color: string
}

function ScreenNode({ data }: NodeProps): JSX.Element {
  const nodeData = data as ScreenNodeData
  const setNodeLabel = useStore((state) => state.setNodeLabel)
  const setEntryNode = useStore((state) => state.setEntryNode)

  return (
    <div
      className={`screennode ${nodeData.entry ? 'entry' : ''} ${nodeData.stub ? 'stub' : ''}`}
      style={{ ['--module-color' as string]: nodeData.color }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="modulestrip">{nodeData.moduleName}</div>
      {nodeData.image ? (
        <img className="shot" src={nodeData.image} alt="" />
      ) : (
        <div className="shot">{nodeData.stub ? 'not designed yet' : ''}</div>
      )}
      <div className="bar">
        <span className="step">{String(nodeData.step).padStart(2, '0')}</span>
        <input
          className="title"
          value={nodeData.label}
          aria-label="Screen name"
          onChange={(event) => setNodeLabel(nodeData.nodeId, event.target.value)}
        />
        <button
          className="entrymark"
          title="Make this the screen the user starts on"
          onClick={() => setEntryNode(nodeData.nodeId)}
        >
          {nodeData.entry ? 'START' : 'SET'}
        </button>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

/** A remark on the canvas. Not a screen, so it stays out of the flow analysis. */
function NoteNode({ data }: NodeProps): JSX.Element {
  const nodeData = data as NoteNodeData
  const setNodeLabel = useStore((state) => state.setNodeLabel)
  const setNodeBody = useStore((state) => state.setNodeBody)

  return (
    <div className="notenode" style={{ ['--module-color' as string]: nodeData.color }}>
      <input
        className="title"
        value={nodeData.label}
        aria-label="Note title"
        onChange={(event) => setNodeLabel(nodeData.nodeId, event.target.value)}
      />
      <textarea
        className="body"
        value={nodeData.body}
        aria-label="Note"
        placeholder="What needs deciding here?"
        onChange={(event) => setNodeBody(nodeData.nodeId, event.target.value)}
      />
    </div>
  )
}

/**
 * An edge whose label is edited in place.
 *
 * The old double-click prompt blocked the whole renderer while it was open,
 * which is also why it could not be driven from a test.
 */
function TriggerEdge(props: EdgeProps): JSX.Element {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label } = props
  const setEdgeTrigger = useStore((state) => state.setEdgeTrigger)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(label ?? ''))

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })

  const commit = (): void => {
    setEditing(false)
    if (draft !== String(label ?? '')) setEdgeTrigger(id, draft)
  }

  return (
    <>
      <BaseEdge id={id} path={path} />
      <EdgeLabelRenderer>
        <div
          className="edgelabel nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {editing ? (
            <input
              autoFocus
              aria-label="What the user does"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit()
                if (event.key === 'Escape') {
                  setDraft(String(label ?? ''))
                  setEditing(false)
                }
              }}
            />
          ) : (
            <button
              onClick={() => {
                setDraft(String(label ?? ''))
                setEditing(true)
              }}
              title="Name what the user does here"
            >
              {String(label ?? '') || 'name this'}
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { screen: ScreenNode, note: NoteNode }
const edgeTypes = { trigger: TriggerEdge }

function Canvas(): JSX.Element {
  const project = useStore((state) => state.project)
  const wireframeUrls = useStore((state) => state.wireframeUrls)
  const sourceUrls = useStore((state) => state.sourceUrls)
  const flowScope = useStore((state) => state.flowScope)
  const setFlowScope = useStore((state) => state.setFlowScope)
  const activeModuleId = useStore((state) => state.activeModuleId)
  const setActiveModule = useStore((state) => state.setActiveModule)
  const setNodePosition = useStore((state) => state.setNodePosition)
  const connectNodes = useStore((state) => state.connectNodes)
  const reconnectEdge = useStore((state) => state.reconnectEdge)
  const removeEdge = useStore((state) => state.removeEdge)
  const applyDraftFlow = useStore((state) => state.applyDraftFlow)
  const selectScreen = useStore((state) => state.selectScreen)
  const addFlowNode = useStore((state) => state.addFlowNode)
  const removeFlowNodes = useStore((state) => state.removeFlowNodes)
  const undoFlow = useStore((state) => state.undoFlow)
  const redoFlow = useStore((state) => state.redoFlow)
  const flowHistory = useStore((state) => state.flowHistory)
  const { screenToFlowPosition } = useReactFlow()

  const visibleNodes = useMemo(() => {
    const all = project?.flow.nodes ?? []
    if (flowScope === 'all' || !activeModuleId) return all
    return all.filter((node) => node.moduleId === activeModuleId)
  }, [project?.flow.nodes, flowScope, activeModuleId])

  const nodes: Node[] = useMemo(() => {
    const moduleById = new Map((project?.modules ?? []).map((module) => [module.id, module]))
    const stepInModule = new Map<string, number>()
    return visibleNodes.map((node) => {
      const module = moduleById.get(node.moduleId)
      const color = module?.color ?? '#37C2CE'

      if (node.kind === 'note') {
        return {
          id: node.id,
          type: 'note',
          position: { x: node.x, y: node.y },
          data: { label: node.label, body: node.body ?? '', nodeId: node.id, color } satisfies NoteNodeData
        }
      }

      const step = (stepInModule.get(node.moduleId) ?? 0) + 1
      stepInModule.set(node.moduleId, step)
      return {
        id: node.id,
        type: 'screen',
        position: { x: node.x, y: node.y },
        // A screen node is re-derived from its screen on every draft, so letting
        // the canvas delete one would only make it vanish until the next
        // Re-draft. Screens are deleted in the source panel.
        deletable: !node.screenId,
        data: {
          label: node.label,
          step,
          entry: Boolean(node.entry),
          image: node.screenId ? wireframeUrls[node.screenId] ?? sourceUrls[node.screenId] : undefined,
          nodeId: node.id,
          moduleName: module?.name ?? 'Module',
          color,
          stub: node.kind === 'stub'
        } satisfies ScreenNodeData
      }
    })
  }, [visibleNodes, project?.modules, wireframeUrls, sourceUrls])

  const edges: Edge[] = useMemo(() => {
    const visible = new Set(visibleNodes.map((node) => node.id))
    return (project?.flow.edges ?? [])
      .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        type: 'trigger',
        source: edge.source,
        target: edge.target,
        label: edge.trigger,
        animated: true,
        className: edge.crossModule ? 'crossmodule' : undefined
      }))
  }, [project?.flow.edges, visibleNodes])

  /** Forward actions on a screen that no transition uses yet. */
  const unrouted = useMemo(() => {
    if (!project) return []
    const out: { nodeId: string; label: string }[] = []
    for (const node of visibleNodes) {
      if (!node.screenId) continue
      const wireframe = project.wireframes[node.screenId]
      if (!wireframe?.actions?.length) continue
      const used = project.flow.edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => edge.trigger.toLowerCase())
      const primary = primaryAction(project, node.screenId)
      for (const action of wireframe.actions) {
        if ((action.rank ?? 1) >= 2) continue
        if (action.key === primary?.key) continue
        if (used.some((trigger) => trigger.includes(action.label.toLowerCase()))) continue
        out.push({ nodeId: node.id, label: action.label })
      }
    }
    return out
  }, [project, visibleNodes])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) connectNodes(connection.source, connection.target)
    },
    [connectNodes]
  )

  // Cmd/Ctrl+Z on the canvas winds the flow back — never a generation run.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      event.preventDefault()
      if (event.shiftKey) redoFlow()
      else undoFlow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoFlow, redoFlow])

  const addAt = useCallback(
    (kind: 'note' | 'stub') => {
      const point = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      addFlowNode(kind, Math.round(point.x), Math.round(point.y))
    },
    [addFlowNode, screenToFlowPosition]
  )

  const orphans = project ? unreachableNodes(project.flow) : []
  const exits = project ? danglingNodes(project.flow) : []
  const modules = project ? sortedModules(project) : []

  if (!project?.flow.nodes.length) {
    return (
      <section className="panel">
        <div className="panel-head">
          <span className="label">User flow</span>
        </div>
        <div className="empty">
          <Route size={22} />
          <h3>No flow drafted yet</h3>
          <p>
            Generate the wireframes and FlowFrame wires the screens together in upload order, guessing
            each transition from the buttons it found. You then drag the connections into the real path.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="label">User flow</span>
        <span className="chip">
          {visibleNodes.length} screens · {edges.length} transitions
        </span>

        <select
          className="field modulepicker"
          value={flowScope === 'all' ? 'all' : (activeModuleId ?? 'all')}
          aria-label="Which module to show"
          onChange={(event) => {
            if (event.target.value === 'all') setFlowScope('all')
            else {
              setActiveModule(event.target.value)
              setFlowScope('module')
            }
          }}
        >
          <option value="all">All modules</option>
          {modules.map((module) => (
            <option key={module.id} value={module.id}>
              {module.name}
            </option>
          ))}
        </select>

        <div className="spacer" />
        <button className="btn ghost small" onClick={() => addAt('note')} title="Add a note to the canvas">
          <StickyNote size={13} />
          Note
        </button>
        <button className="btn ghost small" onClick={() => addAt('stub')} title="Add a screen that does not exist yet">
          <Plus size={13} />
          Screen
        </button>
        <button
          className="btn ghost small"
          onClick={undoFlow}
          disabled={!flowHistory.past.length}
          title="Undo the last change to the flow"
          aria-label="Undo"
        >
          <Undo2 size={13} />
        </button>
        <button
          className="btn ghost small"
          onClick={redoFlow}
          disabled={!flowHistory.future.length}
          title="Redo"
          aria-label="Redo"
        >
          <Redo2 size={13} />
        </button>
        <button className="btn ghost small" onClick={applyDraftFlow} title="Re-draft from upload order">
          <Wand2 size={13} />
          Re-draft
        </button>
      </div>

      <div className="flowwrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onConnect={onConnect}
          onReconnect={(oldEdge, connection) => {
            if (connection.source && connection.target) {
              reconnectEdge(oldEdge.id, connection.source, connection.target)
            }
          }}
          onNodeDragStop={(_event, node) => setNodePosition(node.id, node.position.x, node.position.y)}
          onNodeClick={(_event, node) => {
            const match = project.flow.nodes.find((candidate) => candidate.id === node.id)
            if (match?.screenId) selectScreen(match.screenId)
          }}
          onNodesDelete={(deleted) => removeFlowNodes(deleted.map((node) => node.id))}
          onEdgesDelete={(deleted) => deleted.forEach((edge) => removeEdge(edge.id))}
          fitView
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ animated: true, type: 'trigger' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2b303a" />
          <Controls showInteractive={false} position="top-left" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            bgColor="#14161b"
            maskColor="rgba(20,22,27,0.72)"
            nodeColor={(node) => (node.data as ScreenNodeData).color}
          />
        </ReactFlow>

        <div className="flow-overlay">
          <span className="label">Drag a handle to connect · click a label to name it · ⌘Z undoes</span>
          {orphans.length > 0 && (
            <span className="flow-warning">
              <AlertTriangle size={11} /> {orphans.length} unreachable
            </span>
          )}
          {exits.length > 0 && <span className="label">{exits.length} exit point{exits.length === 1 ? '' : 's'}</span>}
          {unrouted.length > 0 && (
            <span className="label" title={unrouted.map((item) => item.label).join(', ')}>
              {unrouted.length} action{unrouted.length === 1 ? '' : 's'} with nowhere to go
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

export default function FlowCanvas(): JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
