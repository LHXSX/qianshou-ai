/** Separate reviewed-video supply review protocol; no old task-adapters.v1 widening. */
export interface ReviewedVideoSampleAttestation {
  readonly key_id: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: string
}
export interface ReviewedVideoAdapterUpdate {
  readonly request_id: string
  readonly publication_id: string
  readonly worker_id: string
  readonly connection_id: string
  readonly device_key_id: string
  readonly probe_payload_b64u: string
  readonly device_signature_b64u: string
  readonly sample_attestation: ReviewedVideoSampleAttestation
}
export interface ReviewedVideoAdapterAck {
  readonly request_id: string
  readonly connection_id: string
  readonly status: 'accepted' | 'rejected'
  readonly publication_id: string
  readonly task_type: string
  readonly approved_contract_digest: string
}
