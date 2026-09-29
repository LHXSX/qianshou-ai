/** Guided owner-only video workflow draft creation. Saving is not publication or order admission. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceKey } from './marketplace-locales.ts'
import { readVideoApiGraphFile, type VideoWorkflowDraftReceipt, type VideoWorkflowDraftTransport,
  type VideoWorkflowInspection, type VideoWorkflowTemplate } from './video-workflow-authoring.ts'
import css from './VideoWorkflowWizard.module.css'

interface Props {
  readonly t: (key: MarketplaceKey) => string
  readonly transport: VideoWorkflowDraftTransport
  readonly close: () => void
}

export function VideoWorkflowWizard({ t, transport, close }: Props) {
  const [template, setTemplate] = useState<VideoWorkflowTemplate>('image-to-video')
  const [templateChosen, setTemplateChosen] = useState(false)
  const [name, setName] = useState('')
  const [fileName, setFileName] = useState('')
  const [inspection, setInspection] = useState<VideoWorkflowInspection | null>(null)
  const [fileError, setFileError] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [promptIndex, setPromptIndex] = useState(0)
  const [imageIndex, setImageIndex] = useState(0)
  const [frameIndex, setFrameIndex] = useState(-1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saved, setSaved] = useState<VideoWorkflowDraftReceipt | null>(null)
  const [drafts, setDrafts] = useState<readonly VideoWorkflowDraftReceipt[]>([])
  const [listError, setListError] = useState(false)
  const fileRequest = useRef(0)

  useEffect(() => {
    let active = true
    void transport.list().then((items) => { if (active) setDrafts(items) })
      .catch(() => { if (active) setListError(true) })
    return () => { active = false; fileRequest.current++ }
  }, [transport])

  const chooseFile = (file: File | undefined): void => {
    const request = ++fileRequest.current
    setFileName(file?.name ?? '')
    setInspection(null); setFileError(false); setSaved(null); setSaveError(false)
    setPromptIndex(0); setImageIndex(0); setFrameIndex(-1)
    if (file === undefined) return
    void readVideoApiGraphFile(file).then((result) => {
      if (request !== fileRequest.current) return
      if (result !== null) {
        if (!templateChosen) setTemplate(result.images.length === 0 ? 'text-to-video' : 'image-to-video')
        setFrameIndex(result.frames.length === 1 ? 0 : -1)
        setAdvancedOpen(result.prompts.length > 1 || result.images.length > 1 || result.frames.length > 1)
      }
      setInspection(result); setFileError(result === null)
    }).catch(() => { if (request === fileRequest.current) setFileError(true) })
  }

  const canSave = !saving && inspection !== null && name.trim().length >= 2 && name.trim().length <= 80
    && (template === 'text-to-video' ? inspection.images.length === 0 : inspection.images.length === 1)
  const save = (): void => {
    const selected = inspection
    if (selected === null || saving || name.trim().length < 2 || name.trim().length > 80
      || (template === 'text-to-video' ? selected.images.length !== 0 : selected.images.length !== 1)) return
    const prompt = selected.prompts[promptIndex]
    const image = selected.images[imageIndex]
    const frames = selected.frames[frameIndex]
    if (prompt === undefined || (template === 'image-to-video' && image === undefined)) return
    setSaving(true); setSaveError(false); setSaved(null)
    void transport.save({ displayName: name.trim(), template, graph: selected.graph,
      mapping: { prompt: { nodeId: prompt.nodeId, field: prompt.field },
        ...(template === 'image-to-video' && image !== undefined
          ? { referenceImage: { nodeId: image.nodeId, field: 'image' as const } } : {}),
        ...(frames === undefined ? {} : { frames: { nodeId: frames.nodeId,
          field: frames.field as 'length' | 'frames' | 'frame_count' } }),
        outputNodeId: selected.output.nodeId } })
      .then((receipt) => { setSaved(receipt); setDrafts(items => [receipt, ...items.filter(item => item.id !== receipt.id)]) })
      .catch(() => { setSaveError(true) })
      .finally(() => { setSaving(false) })
  }

  return <section className={css.wizard} aria-labelledby="qianshou-video-wizard-title">
    <header className={css.header}>
      <div><p className={css.eyebrow}>{t('videoDraftEyebrow')}</p>
        <h2 id="qianshou-video-wizard-title">{t('videoDraftTitle')}</h2>
        <p>{t('videoDraftIntro')}</p></div>
      <Button variant="outline" size="sm" onClick={close}>{t('videoDraftBack')}</Button>
    </header>
    <ol className={css.steps} aria-label={t('videoDraftSteps')}>
      <li aria-current="step">{t('videoDraftStepDesign')}</li>
      <li aria-disabled="true">{t('videoDraftStepTrial')}</li>
      <li aria-disabled="true">{t('videoDraftStepReview')}</li>
      <li aria-disabled="true">{t('videoDraftStepIntake')}</li>
    </ol>
    <div className={css.body}>
      <section className={css.card}>
        <h3>{t('videoDraftTemplateTitle')}</h3>
        <p className={css.quiet}>{t('videoDraftTemplateHelp')}</p>
        <div className={css.choices} role="group" aria-label={t('videoDraftTemplateTitle')}>
          {(['image-to-video', 'text-to-video'] as const).map(value => <button type="button" key={value}
            aria-pressed={template === value} disabled={saving}
            className={template === value ? css.choiceSelected : css.choice}
            onClick={() => { setTemplate(value); setTemplateChosen(true); setSaved(null); setSaveError(false) }}>
            <strong>{t(value === 'image-to-video' ? 'videoDraftImageTemplate' : 'videoDraftTextTemplate')}</strong>
            <span>{t(value === 'image-to-video' ? 'videoDraftImageHelp' : 'videoDraftTextHelp')}</span>
          </button>)}
        </div>
      </section>
      <section className={css.card}>
        <h3>{t('videoDraftSourceTitle')}</h3>
        <p className={css.quiet}>{t('videoDraftSourceHelp')}</p>
        <label className={css.field}>{t('videoDraftName')}
          <input value={name} maxLength={80} disabled={saving} placeholder={t('videoDraftNamePlaceholder')}
            onChange={(event) => { setName(event.target.value); setSaved(null); setSaveError(false) }} /></label>
        <label className={css.field}>{t('videoDraftFile')}
          <input type="file" accept=".json,application/json" disabled={saving} onChange={(event) => {
            chooseFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''
          }} /></label>
        {fileName && <p className={css.quiet}>{t('videoDraftSelectedFile').replace('{file}', fileName)}</p>}
        {fileError && <p role="alert" className={css.error}>{t('videoDraftFileInvalid')}</p>}
        {inspection !== null && <div className={css.mapping}>
          <p role="status">{t('videoDraftReadSuccess').replace('{count}', String(inspection.nodeCount))}</p>
          <p className={css.inputSummary}>{t('videoDraftDetectedInputs')
            .replace('{image}', t(inspection.images.length === 0 ? 'videoDraftNoImageInput' : 'videoDraftImageDetected'))
            .replace('{frames}', t(inspection.frames.length === 1 ? 'videoDraftFramesDetected' : 'videoDraftFramesUnchanged'))}</p>
          {template === 'text-to-video' && inspection.images.length > 0 && <p role="alert" className={css.error}>
            {t('videoDraftTextImageConflict')}</p>}
          {template === 'image-to-video' && inspection.images.length === 0 && <p role="alert" className={css.error}>
            {t('videoDraftImageMissing')}</p>}
          {template === 'image-to-video' && inspection.images.length > 1 && <p role="alert" className={css.error}>
            {t('videoDraftMultipleImages')}</p>}
          <details className={css.advanced} open={advancedOpen} onToggle={(event) => {
            setAdvancedOpen(event.currentTarget.open)
          }}><summary>{t('videoDraftAdvancedMapping')}</summary>
            <p className={css.quiet}>{t('videoDraftAdvancedHelp')}</p>
            <label className={css.field}>{t('videoDraftPromptInput')}
              <select value={promptIndex} disabled={saving}
                onChange={(event) => { setPromptIndex(Number(event.target.value)); setSaved(null) }}>
                {inspection.prompts.map((item, index) => <option key={`${item.nodeId}:${item.field}`} value={index}>
                  {item.classType} · {item.field} · #{item.nodeId}</option>)}
              </select></label>
            {template === 'image-to-video' && <label className={css.field}>{t('videoDraftImageInput')}
              <select value={imageIndex} disabled={saving}
                onChange={(event) => { setImageIndex(Number(event.target.value)); setSaved(null) }}>
                {inspection.images.length === 0 && <option value="0">{t('videoDraftImageMissing')}</option>}
                {inspection.images.map((item, index) => <option key={`${item.nodeId}:${item.field}`} value={index}>
                  {item.classType} · #{item.nodeId}</option>)}
              </select></label>}
            {inspection.frames.length > 0 && <label className={css.field}>{t('videoDraftFrameInput')}
              <select value={frameIndex} disabled={saving}
                onChange={(event) => { setFrameIndex(Number(event.target.value)); setSaved(null) }}>
                <option value={-1}>{t('videoDraftFrameKeep')}</option>
                {inspection.frames.map((item, index) => <option key={`${item.nodeId}:${item.field}`} value={index}>
                  {item.classType} · {item.field} · #{item.nodeId}</option>)}
              </select></label>}
            <p className={css.quiet}>{t('videoDraftOutput').replace('{type}', inspection.output.classType)}</p>
          </details>
          <p className={css.quiet}>{t('videoDraftMappingScope')}</p>
        </div>}
      </section>
      <div className={css.footer}>
        <Button variant="primary" disabled={!canSave} onClick={save}>
          {t(saving ? 'videoDraftSaving' : 'videoDraftSave')}</Button>
        <span>{t('videoDraftSaveScope')}</span>
      </div>
      {saveError && <p role="alert" className={css.error}>{t('videoDraftSaveFailed')}</p>}
      {saved !== null && <div className={css.saved} role="status">
        <strong>{t('videoDraftSaved').replace('{name}', saved.displayName)}</strong>
        <p>{t('videoDraftNext')}</p>
      </div>}
      {drafts.length > 0 && <section className={css.card}>
        <h3>{t('videoDraftExisting')}</h3>
        <ul className={css.drafts}>{drafts.map(draft => <li key={draft.id}>
          <span>{draft.displayName}</span><small>{t('videoDraftPrivate')}</small>
        </li>)}</ul>
      </section>}
      {listError && <p className={css.quiet}>{t('videoDraftListUnavailable')}</p>}
    </div>
  </section>
}
