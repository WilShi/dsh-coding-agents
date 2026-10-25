import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CodingAgentConfigSnapshot,
  CodingAgentEngine,
  CodingAgentInstallation,
  CodingAgentPermission,
  CodingAgentRunMode,
  CodingAgentRunSnapshot,
  CodingAgentSessionDetail,
  CodingAgentSessionSummary,
} from '../src/types.ts'
import type { CodingAgentsApi } from './api.ts'
import styles from './CodingAgentsView.module.css'

type Tab = 'sessions' | 'run' | 'config'

function engineName(engine: CodingAgentEngine): string {
  return engine === 'codex' ? 'Codex' : 'Claude Code'
}

function dateTime(value: number | undefined): string {
  return value === undefined ? '未知时间' : new Date(value).toLocaleString('zh-CN')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function StateBadge({ state }: { state: CodingAgentRunSnapshot['state'] }) {
  const label = state === 'starting' ? '启动中' : state === 'running' ? '运行中' : state === 'completed' ? '已完成' : state === 'cancelled' ? '已取消' : '失败'
  return <span className={`${styles.badge} ${styles[`state_${state}`] ?? ''}`}>{label}</span>
}

export interface CodingAgentsViewProps {
  api: CodingAgentsApi
}

export function CodingAgentsView({ api }: CodingAgentsViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('sessions')
  const [installations, setInstallations] = useState<CodingAgentInstallation[]>([])
  const [maximum, setMaximum] = useState(4)
  const [sessions, setSessions] = useState<CodingAgentSessionSummary[]>([])
  const [sessionEngine, setSessionEngine] = useState<'all' | CodingAgentEngine>('all')
  const [query, setQuery] = useState('')
  const [cwdFilter, setCwdFilter] = useState('')
  const [archived, setArchived] = useState(false)
  const [selected, setSelected] = useState<CodingAgentSessionDetail>()
  const [sessionsBusy, setSessionsBusy] = useState(false)
  const [runs, setRuns] = useState<CodingAgentRunSnapshot[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [runEngine, setRunEngine] = useState<CodingAgentEngine>('codex')
  const [runMode, setRunMode] = useState<CodingAgentRunMode>('new')
  const [runSessionId, setRunSessionId] = useState('')
  const [runCwd, setRunCwd] = useState('')
  const [runPrompt, setRunPrompt] = useState('')
  const [runModel, setRunModel] = useState('')
  const [runEffort, setRunEffort] = useState('')
  const [runPermission, setRunPermission] = useState<CodingAgentPermission>('workspace-write')
  const [runBusy, setRunBusy] = useState(false)
  const [configEngine, setConfigEngine] = useState<CodingAgentEngine>('codex')
  const [configCwd, setConfigCwd] = useState('')
  const [config, setConfig] = useState<CodingAgentConfigSnapshot>()
  const [configTarget, setConfigTarget] = useState('user')
  const [configKey, setConfigKey] = useState('')
  const [configValue, setConfigValue] = useState('')
  const [configBusy, setConfigBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()

  const loadStatus = useCallback(async () => {
    const result = await api.status()
    setInstallations(result.installations)
    setMaximum(result.maximumConcurrentRuns)
  }, [api])

  const loadSessions = useCallback(async () => {
    setSessionsBusy(true)
    try {
      setSessions(await api.sessions({
        engine: sessionEngine,
        query: query.trim() || undefined,
        cwd: cwdFilter.trim() || undefined,
        archived,
        limit: 100,
      }))
      setFailure(undefined)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setSessionsBusy(false)
    }
  }, [api, archived, cwdFilter, query, sessionEngine])

  const loadRuns = useCallback(async () => {
    try { setRuns(await api.runs()) } catch (error) { setFailure(errorText(error)) }
  }, [api])

  useEffect(() => {
    void Promise.all([loadStatus(), loadSessions(), loadRuns()]).catch(error => setFailure(errorText(error)))
  }, [loadRuns, loadSessions, loadStatus])

  useEffect(() => {
    const active = runs.some(run => run.state === 'starting' || run.state === 'running')
    if (!active) return
    const timer = window.setInterval(() => { void loadRuns() }, 1_000)
    return () => window.clearInterval(timer)
  }, [loadRuns, runs])

  useEffect(() => {
    const root = rootRef.current
    root?.scrollTo({ top: 0, left: 0 })
    root?.scrollIntoView({ block: 'start', inline: 'nearest' })
  }, [tab])

  const selectedRun = useMemo(() => runs.find(run => run.id === selectedRunId) ?? runs[0], [runs, selectedRunId])

  const openSession = async (session: CodingAgentSessionSummary) => {
    try {
      setSelected(await api.detail(session.engine, session.id, session.cwd, 300))
      setFailure(undefined)
    } catch (error) { setFailure(errorText(error)) }
  }

  const loadMessagePage = async (offset: number) => {
    if (selected === undefined) return
    try {
      setSelected(await api.detail(selected.engine, selected.id, selected.cwd, 300, Math.max(0, offset)))
    } catch (error) { setFailure(errorText(error)) }
  }

  const prepareRun = (mode: CodingAgentRunMode, session?: CodingAgentSessionSummary) => {
    setRunMode(mode)
    if (session !== undefined) {
      setRunEngine(session.engine)
      setRunSessionId(session.id)
      setRunCwd(session.cwd ?? '')
    } else {
      setRunSessionId('')
    }
    setTab('run')
  }

  const startRun = async () => {
    if (runPrompt.trim() === '') { setFailure('请先填写要执行的任务。'); return }
    if (runMode !== 'new' && runSessionId.trim() === '') { setFailure('继续或分叉会话需要会话 ID。'); return }
    setRunBusy(true)
    try {
      const started = await api.start({
        engine: runEngine,
        mode: runMode,
        prompt: runPrompt.trim(),
        cwd: runCwd.trim() || undefined,
        sessionId: runMode === 'new' ? undefined : runSessionId.trim(),
        model: runModel.trim() || undefined,
        effort: runEffort.trim() || undefined,
        permission: runPermission,
      })
      setSelectedRunId(started.id)
      setRunPrompt('')
      setNotice(`${engineName(runEngine)} 任务已开始。`)
      await loadRuns()
    } catch (error) { setFailure(errorText(error)) } finally { setRunBusy(false) }
  }

  const mutate = async (action: 'rename' | 'tag' | 'archive' | 'unarchive' | 'fork' | 'rollback' | 'delete') => {
    if (selected === undefined) return
    const input: { title?: string; tag?: string | null; turns?: number } = {}
    if (action === 'rename') {
      const title = window.prompt('新的会话名称', selected.title)
      if (title === null) return
      input.title = title
    }
    if (action === 'tag') {
      const tag = window.prompt('标签（留空可清除）', selected.tag ?? '')
      if (tag === null) return
      input.tag = tag || null
    }
    if (action === 'rollback') {
      const raw = window.prompt('回滚最近几轮？', '1')
      if (raw === null) return
      input.turns = Math.max(1, Number(raw) || 1)
    }
    if (action === 'delete' && !window.confirm(`确定删除“${selected.title}”吗？此操作不能撤销。`)) return
    try {
      const result = await api.mutate({ engine: selected.engine, sessionId: selected.id, cwd: selected.cwd, action, ...input })
      setNotice(action === 'fork' ? `已创建分叉会话 ${result.sessionId}` : '会话操作已完成。')
      if (action === 'delete') setSelected(undefined)
      await loadSessions()
    } catch (error) { setFailure(errorText(error)) }
  }

  const loadConfig = async () => {
    setConfigBusy(true)
    try {
      const snapshot = await api.config(configEngine, configCwd.trim() || undefined)
      setConfig(snapshot)
      setConfigTarget(snapshot.editableTargets.some(target => target.id === configTarget) ? configTarget : snapshot.editableTargets[0]?.id ?? 'user')
      setFailure(undefined)
    } catch (error) { setFailure(errorText(error)) } finally { setConfigBusy(false) }
  }

  useEffect(() => { if (tab === 'config') void loadConfig() }, [configEngine, tab])

  const writeConfig = async (remove = false) => {
    if (configKey.trim() === '') { setFailure('请填写配置键。'); return }
    let value: unknown
    if (!remove) {
      try { value = JSON.parse(configValue) } catch { setFailure('配置值必须是合法 JSON，例如 "high"、true 或 {"allow":[]}。'); return }
    }
    setConfigBusy(true)
    try {
      const snapshot = await api.writeConfig({ engine: configEngine, cwd: configCwd.trim() || undefined, target: configTarget, keyPath: configKey.trim(), value, remove })
      setConfig(snapshot)
      setNotice(remove ? '配置项已移除。' : '配置已保存，并已刷新有效配置。')
      setFailure(undefined)
    } catch (error) { setFailure(errorText(error)) } finally { setConfigBusy(false) }
  }

  return <div ref={rootRef} className={styles.root}>
    <header className={styles.header}>
      <div>
        <h2>编程助手</h2>
        <p>在 DSH 中统一管理、检索和直接控制 Codex 与 Claude Code。</p>
      </div>
      <button className={styles.primaryButton} onClick={() => prepareRun('new')}>＋ 新建任务</button>
    </header>

    <section className={styles.installations}>
      {installations.map(item => <div className={styles.installationCard} key={item.engine}>
        <span className={`${styles.engineMark} ${item.engine === 'codex' ? styles.codex : styles.claude}`}>{item.engine === 'codex' ? 'CX' : 'CC'}</span>
        <div><strong>{item.label}</strong><span>{item.version ?? '未知版本'}</span></div>
        <span className={item.available ? styles.online : styles.offline}>{item.available ? '可用' : '不可用'}</span>
      </div>)}
      <div className={styles.capacity}>并行任务 <strong>{runs.filter(run => run.state === 'starting' || run.state === 'running').length}</strong> / {maximum}</div>
    </section>

    {(failure !== undefined || notice !== undefined) && <div className={failure === undefined ? styles.notice : styles.failure}>
      <span>{failure ?? notice}</span><button onClick={() => { setFailure(undefined); setNotice(undefined) }}>×</button>
    </div>}

    <nav className={styles.tabs}>
      <button className={tab === 'sessions' ? styles.activeTab : ''} onClick={() => setTab('sessions')}>历史会话</button>
      <button className={tab === 'run' ? styles.activeTab : ''} onClick={() => setTab('run')}>任务控制</button>
      <button className={tab === 'config' ? styles.activeTab : ''} onClick={() => setTab('config')}>配置管理</button>
    </nav>

    {tab === 'sessions' && <div className={styles.sessionLayout}>
      <aside className={styles.sessionSidebar}>
        <div className={styles.filters}>
          <select value={sessionEngine} onChange={event => setSessionEngine(event.target.value as 'all' | CodingAgentEngine)}>
            <option value="all">全部助手</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option>
          </select>
          <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void loadSessions() }} placeholder="搜索标题、消息或标签" />
          <input value={cwdFilter} onChange={event => setCwdFilter(event.target.value)} placeholder="工作区路径（可选）" />
          <label className={styles.check}><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />查看 Codex 归档</label>
          <button className={styles.secondaryButton} disabled={sessionsBusy} onClick={() => void loadSessions()}>{sessionsBusy ? '刷新中…' : '刷新会话'}</button>
        </div>
        <div className={styles.sessionList}>
          {sessions.map(session => <button key={`${session.engine}:${session.id}`} className={`${styles.sessionItem} ${selected?.id === session.id && selected.engine === session.engine ? styles.selectedItem : ''}`} onClick={() => void openSession(session)}>
            <span className={styles.sessionTop}><b>{session.title}</b><i>{session.engine === 'codex' ? 'Codex' : 'Claude'}</i></span>
            <span>{session.preview || '暂无摘要'}</span><small>{dateTime(session.updatedAt)}</small>
          </button>)}
          {!sessionsBusy && sessions.length === 0 && <div className={styles.empty}>没有找到历史会话</div>}
        </div>
      </aside>
      <main className={styles.detail}>
        {selected === undefined ? <div className={styles.emptyHero}><span>◎</span><h3>选择一个历史会话</h3><p>可以查看消息、继续执行、分叉或管理会话。</p></div> : <>
          <div className={styles.detailHeader}>
            <div><span className={styles.kicker}>{engineName(selected.engine)}</span><h3>{selected.title}</h3><p>{selected.cwd ?? '未记录工作区'} · 当前显示 {selected.messages.length} / {selected.totalMessageCount} 条</p></div>
            <div className={styles.actionRow}>
              <button onClick={() => prepareRun('resume', selected)}>继续</button><button onClick={() => prepareRun('fork', selected)}>分叉并执行</button><button onClick={() => void mutate('rename')}>重命名</button>
              {selected.engine === 'codex' ? <button onClick={() => void mutate(selected.archived ? 'unarchive' : 'archive')}>{selected.archived ? '取消归档' : '归档'}</button> : <button onClick={() => void mutate('tag')}>标签</button>}
              {selected.engine === 'codex' && <button onClick={() => void mutate('rollback')}>回滚</button>}
              <button className={styles.dangerButton} onClick={() => void mutate('delete')}>删除</button>
            </div>
          </div>
          <div className={styles.historyPager}><button disabled={!selected.hasMoreBefore} onClick={() => void loadMessagePage(selected.messageOffset - 300)}>较早消息</button><span>{selected.messageOffset + 1}–{selected.messageOffset + selected.messages.length} / {selected.totalMessageCount}</span><button disabled={!selected.hasMoreAfter} onClick={() => void loadMessagePage(selected.messageOffset + 300)}>较新消息</button></div>
          <div className={styles.messages}>{selected.messages.map(message => <article key={message.id} className={`${styles.message} ${styles[`role_${message.role}`] ?? ''}`}><header>{message.role === 'user' ? '用户' : message.role === 'assistant' ? engineName(selected.engine) : message.role === 'tool' ? '工具' : '系统'}{message.kind !== undefined && <span>{message.kind}</span>}</header><pre>{message.text}</pre></article>)}</div>
        </>}
      </main>
    </div>}

    {tab === 'run' && <div className={styles.runLayout}>
      <section className={styles.composerCard}>
        <div className={styles.sectionTitle}><div><h3>执行任务</h3><p>新建、继续或分叉原生会话，输出与工具过程会实时显示。</p></div></div>
        <div className={styles.formGrid}>
          <label>助手<select value={runEngine} onChange={event => setRunEngine(event.target.value as CodingAgentEngine)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
          <label>方式<select value={runMode} onChange={event => setRunMode(event.target.value as CodingAgentRunMode)}><option value="new">新建会话</option><option value="resume">继续会话</option><option value="fork">分叉会话</option></select></label>
          <label>权限<select value={runPermission} onChange={event => setRunPermission(event.target.value as CodingAgentPermission)}><option value="read-only">只读</option><option value="workspace-write">工作区可写（推荐）</option><option value="full-access">完全访问</option></select></label>
          <label>工作区<input value={runCwd} onChange={event => setRunCwd(event.target.value)} placeholder="D:\\project" /></label>
          {runMode !== 'new' && <label className={styles.span2}>会话 ID<input value={runSessionId} onChange={event => setRunSessionId(event.target.value)} /></label>}
          <label>模型（可选）<input value={runModel} onChange={event => setRunModel(event.target.value)} placeholder="使用工具默认模型" /></label>
          <label>思考强度（可选）<input value={runEffort} onChange={event => setRunEffort(event.target.value)} placeholder="low / medium / high" /></label>
        </div>
        <label className={styles.promptLabel}>任务内容<textarea value={runPrompt} onChange={event => setRunPrompt(event.target.value)} rows={7} placeholder="描述希望 Codex 或 Claude Code 完成的任务…" /></label>
        <div className={styles.submitRow}><span>任务会保留在原工具的历史中，可随时继续。</span><button className={styles.primaryButton} disabled={runBusy} onClick={() => void startRun()}>{runBusy ? '正在启动…' : '开始执行'}</button></div>
      </section>
      <aside className={styles.runListCard}>
        <div className={styles.sectionTitle}><div><h3>最近任务</h3><p>自动刷新运行状态</p></div><button onClick={() => void loadRuns()}>刷新</button></div>
        <div className={styles.runList}>{runs.map(run => <button key={run.id} className={selectedRun?.id === run.id ? styles.selectedItem : ''} onClick={() => setSelectedRunId(run.id)}><span><b>{engineName(run.engine)}</b><StateBadge state={run.state} /></span><small>{run.mode} · {dateTime(run.startedAt)}</small></button>)}</div>
        {selectedRun !== undefined && <div className={styles.runDetail}><div className={styles.runDetailTop}><span>会话 {selectedRun.sessionId?.slice(0, 12) ?? '创建中'}…</span>{(selectedRun.state === 'starting' || selectedRun.state === 'running') && <button className={styles.dangerButton} onClick={() => void api.cancel(selectedRun.id).then(loadRuns).catch(error => setFailure(errorText(error)))}>取消</button>}</div>{selectedRun.error !== undefined && <div className={styles.runError}>{selectedRun.error}</div>}<pre>{selectedRun.output || selectedRun.events.map(event => `[${event.type}] ${event.text}`).join('\n') || '等待输出…'}</pre></div>}
      </aside>
    </div>}

    {tab === 'config' && <div className={styles.configLayout}>
      <section className={styles.configEditor}>
        <div className={styles.sectionTitle}><div><h3>配置管理</h3><p>查看生效结果与来源，修改前自动保护原配置。</p></div></div>
        <div className={styles.formGrid}>
          <label>助手<select value={configEngine} onChange={event => setConfigEngine(event.target.value as CodingAgentEngine)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
          <label>工作区（项目配置需要）<input value={configCwd} onChange={event => setConfigCwd(event.target.value)} placeholder="可选" /></label>
          <label>写入位置<select value={configTarget} onChange={event => setConfigTarget(event.target.value)}>{(config?.editableTargets ?? [{ id: 'user', label: '用户配置' }]).map(target => <option value={target.id} key={target.id}>{target.label}</option>)}</select></label>
          <label>配置键<input value={configKey} onChange={event => setConfigKey(event.target.value)} placeholder="例如 model 或 permissions.defaultMode" /></label>
          <label className={styles.span2}>JSON 值<textarea rows={5} value={configValue} onChange={event => setConfigValue(event.target.value)} placeholder={'例如 "high"、true、["Read(*)"] 或 {"defaultMode":"acceptEdits"}'} /></label>
        </div>
        <div className={styles.submitRow}><button className={styles.secondaryButton} disabled={configBusy} onClick={() => void loadConfig()}>读取配置</button><span /><button className={styles.dangerButton} disabled={configBusy} onClick={() => void writeConfig(true)}>移除配置项</button><button className={styles.primaryButton} disabled={configBusy} onClick={() => void writeConfig(false)}>保存配置</button></div>
      </section>
      <aside className={styles.configPreview}><h3>当前有效配置</h3><p>{config?.sources.length ?? 0} 个配置来源</p><pre>{config === undefined ? '点击“读取配置”查看。' : JSON.stringify(config, null, 2)}</pre></aside>
    </div>}
  </div>
}

export default CodingAgentsView
