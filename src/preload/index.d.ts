import type { FlowFrameApi } from './index'

declare global {
  interface Window {
    flowframe: FlowFrameApi
  }
}

export {}
