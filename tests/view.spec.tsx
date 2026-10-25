// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodingAgentsView } from '../src-client/CodingAgentsView.tsx'
import type { CodingAgentsApi } from '../src-client/api.ts'

afterEach(() => cleanup())

function api(): CodingAgentsApi {
  return {
    status: vi.fn(async () => ({ installations: [
      { engine: 'codex', label: 'Codex', available: true, version: '1.0', dataDirectory: 'C:/codex', configFile: 'C:/codex/config.toml' },
      { engine: 'claude-code', label: 'Claude Code', available: true, version: '2.0', dataDirectory: 'C:/claude', configFile: 'C:/claude/settings.json' },
    ], running: 0, maximumConcurrentRuns: 4 })),
    sessions: vi.fn(async () => [{ engine: 'codex', id: 'thread-1', title: '修复构建', preview: '检查测试', cwd: 'D:/project', updatedAt: 1 }]),
    detail: vi.fn(async () => ({ engine: 'codex', id: 'thread-1', title: '修复构建', preview: '检查测试', cwd: 'D:/project', updatedAt: 1, messages: [{ id: 'm1', role: 'user', text: '请修复', kind: 'userMessage' }] })),
    mutate: vi.fn(async () => ({ sessionId: 'thread-1' })),
    config: vi.fn(async engine => ({ engine, effective: { model: 'test' }, sources: [], editableTargets: [{ id: 'user', label: '用户配置', path: 'config' }] })),
    writeConfig: vi.fn(async change => ({ engine: change.engine, effective: {}, sources: [], editableTargets: [] })),
    runs: vi.fn(async () => []),
    run: vi.fn(async () => { throw new Error('unused') }),
    start: vi.fn(async request => ({ id: 'run-1', engine: request.engine, mode: request.mode, state: 'starting', startedAt: Date.now(), output: '', events: [] })),
    cancel: vi.fn(async () => { throw new Error('unused') }),
  }
}

describe('CodingAgentsView', () => {
  it('loads history, opens details, and starts a task', async () => {
    const service = api()
    render(<CodingAgentsView api={service} />)
    expect(await screen.findByText('修复构建')).toBeTruthy()
    fireEvent.click(screen.getByText('修复构建'))
    expect(await screen.findByText('请修复')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByText('执行任务')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('描述希望 Codex 或 Claude Code 完成的任务…'), { target: { value: '运行测试' } })
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ engine: 'codex', mode: 'resume', sessionId: 'thread-1', prompt: '运行测试' })))
  })

  it('shows effective configuration in the dedicated tab', async () => {
    const service = api()
    render(<CodingAgentsView api={service} />)
    fireEvent.click(screen.getByRole('button', { name: '配置管理' }))
    expect(await screen.findByText('当前有效配置')).toBeTruthy()
    await waitFor(() => expect(service.config).toHaveBeenCalled())
    expect(await screen.findByText(/"model": "test"/u)).toBeTruthy()
  })
})
