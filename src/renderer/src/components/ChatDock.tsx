import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Eraser, Paperclip, Send, Square } from 'lucide-react'
import { useStore } from '../state/store'

const STARTERS = [
  'Where does this flow break down?',
  'What screens or states are missing?',
  'Write the happy path as numbered steps.',
  'Suggest better button copy for this screen.'
]

interface Props {
  onOpenSettings: () => void
}

export default function ChatDock({ onOpenSettings }: Props): JSX.Element {
  const project = useStore((state) => state.project)
  const settings = useStore((state) => state.settings)
  const providers = useStore((state) => state.providers)
  const chatBusy = useStore((state) => state.chatBusy)
  const sendChat = useStore((state) => state.sendChat)
  const stopChat = useStore((state) => state.stopChat)
  const clearChat = useStore((state) => state.clearChat)
  const selectedScreenId = useStore((state) => state.selectedScreenId)

  const [text, setText] = useState('')
  const [attach, setAttach] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const messages = project?.chat ?? []
  const active = providers.find((provider) => provider.id === settings.activeProvider)
  const model = settings.providers[settings.activeProvider].model
  const canSeeImages = Boolean(model && active?.visionModels.includes(model))
  const visionSuggestion = active?.visionModels[0]

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])

  const submit = (): void => {
    if (!text.trim() || chatBusy) return
    void sendChat(text, attach)
    setText('')
  }

  return (
    <section className={`dock ${collapsed ? 'collapsed' : ''}`}>
      <div className="dock-head">
        <span className="label">Ask about the flow</span>

        <button
          className={`chip ${active?.reachable ? 'live' : 'down'}`}
          onClick={onOpenSettings}
          title="Change provider or model"
        >
          <span className="dot" />
          {settings.activeProvider}
          {model ? ` · ${model}` : ' · pick a model'}
        </button>

        {!active?.reachable ? (
          <span className="label">{active?.detail ?? 'checking…'}</span>
        ) : !canSeeImages && model ? (
          <span className="vision-note">
            <strong>Text only.</strong>{' '}
            {visionSuggestion
              ? `Switch to ${visionSuggestion} to ask about a screenshot.`
              : 'Pull a vision model to ask about a screenshot.'}
          </span>
        ) : null}

        <div className="spacer" />

        <button className="btn ghost small" onClick={clearChat} disabled={!messages.length}>
          <Eraser size={13} />
          Clear
        </button>
        <button className="btn ghost small" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="dock-log" ref={logRef}>
            {messages.length === 0 ? (
              <div className="starters">
                {STARTERS.map((starter) => (
                  <button key={starter} onClick={() => setText(starter)}>
                    {starter}
                  </button>
                ))}
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`msg ${message.role} ${message.error ? 'failed' : ''}`}
                >
                  <span className="who">{message.role === 'user' ? 'You' : message.model || 'model'}</span>
                  <div className="body">
                    {message.content}
                    {chatBusy && message.role === 'assistant' && !message.content && (
                      <span className="caret" />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="composer">
            <button
              className={`btn small ${attach && canSeeImages ? '' : 'ghost'}`}
              onClick={() => setAttach((value) => !value)}
              title={
                !selectedScreenId
                  ? 'Select a screen to attach it'
                  : canSeeImages
                    ? 'Send the selected screenshot with the message'
                    : `${model} reads text only, so the screenshot will be left off`
              }
              disabled={!selectedScreenId || !canSeeImages}
            >
              <Paperclip size={13} />
              {attach && canSeeImages ? 'Screen attached' : 'Text only'}
            </button>

            <textarea
              value={text}
              placeholder="Ask about the flow, the screens, or the copy. Enter to send, Shift+Enter for a new line."
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
            />

            {chatBusy ? (
              <button className="send stop" data-state="busy" onClick={stopChat} title="Stop">
                <Square size={14} />
              </button>
            ) : (
              <button
                className="send"
                data-state="idle"
                onClick={submit}
                disabled={!text.trim()}
                title="Send"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
