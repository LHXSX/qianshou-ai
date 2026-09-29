/** Read-only local source contract; it grants no publication or execution permission. */
export interface LocalSkillTrialDefinition {
  readonly schema: 'qianshou.local-skill-trial.v1'
  readonly taskType: string
  readonly artifactDigest: string
  /** Bounded source JSON crosses the Remote codec without an unconstrained object. */
  readonly inputSchemaJson: string | null
  readonly supportsLocalTrial: boolean
  readonly unavailableReason: 'file-trial-unavailable' | 'runtime-unavailable' | null
}

/** A form read may pin the current source, while existing explicit tool calls remain compatible. */
export interface LocalSkillTrialRequest {
  readonly source: 'user-dsh' | 'user-agents'
  readonly name: string
  readonly inputJson: string
  readonly expectedArtifactDigest?: string
}
