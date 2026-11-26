import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { projectPatrolCurrent } from './patrol-model'

const cards = ['a', 'b'].map(id => ({
  id: `example-task-${id}`,
  title: `【待上线】service｜旧技术标题 ${id}`,
  status: 'blocked',
  latest_summary: 'raw_protocol_failure hidden-run-id',
  body: `**PR：** [当前提案 CLOSED未合并](https://github.com/example/service/pull/31)\n项目：service\n看板问题：请求异常需要补评审 ${id}\n当前结论：工具续接失败，评审补充尚未完成 ${id}\n下一步：恢复原会话后补评审答复与回归\n负责方：巡检执行器维护方\n需要你：当前不要合并\n<details><summary>旧记录</summary>历史技术内容 raw_protocol_failure hidden-run-id ${'旧日志'.repeat(15000)} [旧PR](https://github.com/example/service/pull/4)</details>`
}))

it('keeps a helper label explicit and shows only its current primary PR', () => {
  const current = projectPatrolCurrent({ id: 'helper', title: 'old build process', status: 'ready', body: '当前事项：补齐打包证据\n当前结论：仍缺当前版本打包结果\n下一步：构建器提供结果\n负责方：原构建器\n需要你：等待构建结果\nPR：[修复 OPEN](https://github.com/example/service/pull/31) · [诊断 Draft](https://github.com/example/service/pull/32)' })
  expect(current.title.text).toBe('补齐打包证据')
  expect(current.refs.map(ref => ref.number)).toEqual(['31'])
})

const details = Object.fromEntries(
  cards.map(card => [
    card.id,
    {
      task: card,
      comments: [{ id: 'previous-comment', body: '保留的原始留言', author: 'example', created_at: 1 }],
      events: [],
      attachments: [],
      links: { parents: [], children: [] },
      runs: []
    }
  ])
)

function dashboard(fetchJSON: ReturnType<typeof vi.fn>, profile = 'default') {
  let Page: React.ComponentType = () => null

  const element =
    (tag: string) =>
    ({ children, onValueChange: _change, size: _size, variant: _variant, ...props }: any) =>
      React.createElement(tag, props, children)

  Object.assign(window, {
    __HERMES_PLUGIN_SDK__: {
      React,
      hooks: React,
      components: {
        Button: element('button'),
        Input: element('input'),
        Select: element('select'),
        SelectOption: element('option'),
        Card: element('div'),
        CardContent: element('div'),
        Badge: element('span'),
        Label: element('label')
      },
      utils: { cn: (...args: string[]) => args.join(' '), timeAgo: () => '' },
      fetchJSON,
      buildWsUrl: () => new Promise(() => {})
    },
    __HERMES_PLUGINS__: {
      register: (_name: string, component: React.ComponentType) => {
        Page = component
      }
    }
  })
  const script = window.document.createElement('script')
  script.setAttribute('data-hermes-profile', profile)
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script)

  try {
    // The real served IIFE registers the original route; no private component export or source rewrite.
    new Function(readFileSync(resolve(process.cwd(), '../../plugins/kanban/dashboard/dist/index.js'), 'utf8'))()
  } finally {
    currentScript.mockRestore()
  }

  return Page
}

function source() {
  return vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
    if (url.includes('/boards')) {
      return {
        current: 'patrol',
        boards: [
          { slug: 'patrol', total: 2 },
          { slug: 'other', total: 2 }
        ]
      }
    }

    if (url.includes('/board?')) {
      return { columns: [{ name: 'blocked', tasks: cards }], tenants: [], assignees: [] }
    }

    if (url.includes('/home-channels')) {
      return {
        home_channels: [{ platform: 'example', name: 'Example room', chat_id: 'example-room', subscribed: false }]
      }
    }

    const id = url.match(/\/tasks\/([^/?]+)/)?.[1]

    if (id && url.includes('/comments') && options?.method === 'POST') {
      const body = JSON.parse(options.body!).body
      details[id] = {
        ...details[id],
        comments: [...details[id].comments, { id: 'new-comment', body, author: 'example', created_at: 2 }]
      }

      return {}
    }

    if (id && url.includes('/log')) {
      return { log: '技术日志', running: false }
    }

    if (id) {
      return details[id]
    }

    return {}
  })
}

async function openCard(id: 'a' | 'b') {
  fireEvent.click(await screen.findByRole('button', { name: `请求异常需要补评审 ${id}` }))

  return screen.findByRole('region', { name: '当前概况' })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

it('screenshot-matched Dashboard drawer defaults to authored current facts and conditionally mounts the unchanged history', async () => {
  localStorage.setItem('hermes.kanban.selectedBoard', 'patrol')
  const fetchJSON = source()
  const Page = dashboard(fetchJSON)
  const view = render(<Page />)
  const current = await openCard('a')
  expect(within(current).getByRole('heading').textContent).toBe('请求异常需要补评审 a')
  expect(within(current).getByText('受阻')).toBeTruthy()

  for (const text of [
    '当前结论',
    '下一步',
    '负责方',
    '需要你',
    '工具续接失败，评审补充尚未完成 a',
    '恢复原会话后补评审答复与回归',
    '巡检执行器维护方',
    '当前不要合并'
  ]) {
    expect(within(current).getByText(text)).toBeTruthy()
  }

  expect(
    within(current)
      .getByRole('link', { name: /example\/service #31 · 已关闭/ })
      .getAttribute('href')
  ).toBe('https://github.com/example/service/pull/31')
  expect(view.container.textContent).not.toMatch(
    /Notify home channels|Description|Comments reach the worker|历史技术内容|raw_protocol|hidden-run-id|example-task-a|保留的原始留言/
  )
  expect(fetchJSON.mock.calls.some(([url]) => /\/log|home-channels/.test(url))).toBe(false)
  expect(screen.queryByRole('button', { name: 'Unblock' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '历史与技术记录' }))
  await screen.findByText('Notify home channels')
  expect(screen.getByText('Description')).toBeTruthy()
  expect(screen.getByText('保留的原始留言')).toBeTruthy()
  expect(
    screen.getByText(/Comments reach the worker on its next run or kanban_show\(\) — no need to block the task first\./)
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Unblock' })).toBeTruthy()
  expect(fetchJSON.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '返回当前概况' }))
  expect(screen.queryByText('Description')).toBeNull()
  expect(screen.queryByText('保留的原始留言')).toBeNull()
  expect(view.container.textContent).not.toContain('历史技术内容')
  expect(screen.getByRole('region', { name: '当前概况' })).toBeTruthy()
})

it('留言 uses the original comment endpoint and preserves the same source record and comments', async () => {
  localStorage.setItem('hermes.kanban.selectedBoard', 'patrol')
  const fetchJSON = source()
  const Page = dashboard(fetchJSON)
  render(<Page />)
  await openCard('a')
  fireEvent.click(screen.getByRole('button', { name: '留言' }))
  fireEvent.change(screen.getByRole('textbox', { name: '留言内容' }), { target: { value: '请补充当前审核结论' } })
  fireEvent.click(screen.getByRole('button', { name: '发送留言' }))
  await waitFor(() =>
    expect(
      fetchJSON.mock.calls.some(
        ([url, options]) =>
          url === '/api/plugins/kanban/tasks/example-task-a/comments?board=patrol' &&
          options?.method === 'POST' &&
          options.body === JSON.stringify({ body: '请补充当前审核结论' })
      )
    ).toBe(true)
  )
  fireEvent.click(screen.getByRole('button', { name: '历史与技术记录' }))
  await screen.findByText('请补充当前审核结论')
  expect(screen.getByText('保留的原始留言')).toBeTruthy()
  expect(fetchJSON.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it('task switching resets history and compose synchronously and rejects an out-of-order original-card response', async () => {
  localStorage.setItem('hermes.kanban.selectedBoard', 'patrol')
  const base = source()
  let delay = false
  let finish!: (data: unknown) => void

  const fetchJSON = vi.fn((url: string, options?: any) =>
    delay && url === '/api/plugins/kanban/tasks/example-task-a?board=patrol'
      ? new Promise(resolve => {
          finish = resolve
        })
      : base(url, options)
  )

  const Page = dashboard(fetchJSON)
  render(<Page />)
  await openCard('a')
  fireEvent.click(screen.getByRole('button', { name: '留言' }))
  fireEvent.change(screen.getByRole('textbox', { name: '留言内容' }), { target: { value: '未发送草稿' } })
  await openCard('b')
  expect(screen.queryByRole('textbox', { name: '留言内容' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '留言' }))
  expect((screen.getByRole('textbox', { name: '留言内容' }) as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '历史与技术记录' }))
  await screen.findByText('Description')
  delay = true
  fireEvent.click(screen.getByRole('button', { name: '请求异常需要补评审 a' }))
  expect(screen.queryByText('Description')).toBeNull()
  expect(screen.queryByRole('region', { name: '当前概况' })).toBeNull()
  expect(screen.getByText('正在加载当前概况…')).toBeTruthy()
  await openCard('b')
  await act(async () => {
    finish(details['example-task-a'])
    await Promise.resolve()
  })
  expect(within(screen.getByRole('region', { name: '当前概况' })).getByRole('heading').textContent).toBe(
    '请求异常需要补评审 b'
  )
  expect(screen.queryByRole('button', { name: '返回当前概况' })).toBeNull()
  expect(fetchJSON.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('profile remount discards pending reads, and other boards keep the screenshot-matched legacy drawer', async () => {
  localStorage.setItem('hermes.kanban.selectedBoard', 'patrol')
  const base = source()
  let finish!: (data: unknown) => void

  const old = vi.fn((url: string, options?: any) =>
    url === '/api/plugins/kanban/tasks/example-task-a?board=patrol'
      ? new Promise(resolve => {
          finish = resolve
        })
      : base(url, options)
  )

  const OldPage = dashboard(old, 'old-profile')
  const view = render(<OldPage />)
  fireEvent.click(await screen.findByRole('button', { name: '请求异常需要补评审 a' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  const NewPage = dashboard(base, 'new-profile')
  view.rerender(<NewPage />)
  await openCard('b')
  await act(async () => {
    finish(details['example-task-a'])
    await Promise.resolve()
  })
  expect(within(screen.getByRole('region', { name: '当前概况' })).getByRole('heading').textContent).toBe(
    '请求异常需要补评审 b'
  )
  cleanup()
  localStorage.setItem('hermes.kanban.selectedBoard', 'other')
  const OtherPage = dashboard(base, 'new-profile')
  render(<OtherPage />)
  fireEvent.click(await screen.findByText(cards[0].title))
  await screen.findByText('Notify home channels')
  expect(screen.getByText('Description')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '历史与技术记录' })).toBeNull()
  expect(screen.queryByRole('region', { name: '当前概况' })).toBeNull()
})

it('current projection uses only authored fields, escapes at the adapter boundary, and never crops a qualification', () => {
  const current = projectPatrolCurrent({
    id: 'example',
    title: '【待上线】旧标题',
    status: 'done',
    latest_summary: '不得拿来作为当前结论',
    body:
      '看板问题：<img src=x onerror=alert(1)>\n当前结论：尚未恢复，不要合并\n下一步：' +
      '待确认'.repeat(40) +
      '\n<details>负责方：历史负责人</details>'
  })

  expect(current.status).toBe('已完成')
  expect(current.title.full).toBe('<img src=x onerror=alert(1)>')
  expect(current.facts[0].text).toBe('尚未恢复，不要合并')
  expect(current.facts[1].text).toBe('字段较长，请展开历史与技术记录查看完整内容')
  expect(current.facts[2].text).toBe('负责方待确认')
  expect(current.facts[3].text).toBe('待明确是否需要你处理')
  expect(current.facts.every(fact => Array.from(fact.text).length <= 80)).toBe(true)
})

it('actual Dashboard current-field markup renders as escaped text without an executable element', async () => {
  localStorage.setItem('hermes.kanban.selectedBoard', 'patrol')
  const base = source()
  const literal = '<img src=x onerror=alert(1)>'

  const fetchJSON = vi.fn((url: string, options?: any) =>
    url === '/api/plugins/kanban/tasks/example-task-a?board=patrol'
      ? Promise.resolve({
          ...details['example-task-a'],
          task: {
            ...cards[0],
            body: cards[0].body.replace('当前结论：工具续接失败，评审补充尚未完成 a', `当前结论：${literal}`)
          }
        })
      : base(url, options)
  )

  const Page = dashboard(fetchJSON)
  render(<Page />)
  const current = await openCard('a')
  expect(within(current).getByText(literal)).toBeTruthy()
  expect(current.querySelector('img')).toBeNull()
  expect(current.querySelector('script')).toBeNull()
})
