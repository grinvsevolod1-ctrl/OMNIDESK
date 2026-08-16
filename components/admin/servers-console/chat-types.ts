import type {
  AssistantResult,
  CredentialRequest,
  ExecutedAction,
  LaunchedDeploy,
  OpenPanel,
} from '@/lib/servers-console/assistant'

/** One rendered turn in the conversation. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ExecutedAction[]
  openPanel?: OpenPanel | null
  credentialRequest?: CredentialRequest | null
  launchedDeploy?: LaunchedDeploy | null
  source?: AssistantResult['source']
  streaming?: boolean
}
