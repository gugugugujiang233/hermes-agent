/** Pure display projection. Dashboard embeds this via sync-patrol.mjs; no runtime host crossing. */
export interface PatrolTask {
  id: string
  title?: string
  body?: string | null
  status: string
  latest_summary?: string | null
  link_counts?: { parents: number; children: number }
  tenant?: string | null
}

export interface PatrolDetail {
  task: PatrolTask
  links: { parents: string[]; children: string[] }
}

export interface PatrolRef {
  url: string
  number: string
  repo: string
  state: string
}

export interface PatrolRow {
  ids: string[]
  project: string
  issue: string
  issueFull: string
  status: string
  gate: string
  gateFull: string
  refs: PatrolRef[]
  search: string
  members?: { id: string; title: string; status: string; gate: string }[]
}

export const PATROL_COLUMNS = ['项目', '问题', '状态', '还差什么', 'PR']

/** Everything after the first details opener is history, including nested details. */
function currentBody(body: string): string {
  return body.split(/<details\b/i, 1)[0]
}

function plain(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function field(body: string, name: string): string {
  const line = body
    .split('\n')
    .find(line => new RegExp(`^\\s*(?:[-*]\\s+)?${name}\\s*[：:]`).test(line.replace(/\*\*/g, '')))

  return line ? plain(line.replace(/\*\*/g, '').replace(new RegExp(`^\\s*(?:[-*]\\s+)?${name}\\s*[：:]`), '')) : ''
}

function section(body: string, name: string): string {
  const match = body.match(new RegExp(`^#{1,3}\\s*${name}\\s*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, 'm'))

  return plain(match?.[1] ?? '')
}

function short(value: string, max: number): string {
  const chars = Array.from(value)

  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value
}

function references(body: string): PatrolRef[] {
  const refs = new Map<string, PatrolRef>()
  const preamble = body.split('\n').find(line => /^\s*PR\s*[：:]/i.test(line.replace(/\*\*/g, '')))
  const source = preamble ?? body

  const pattern =
    /\[([^\]]*)\]\((https:\/\/(?:github\.com|gitlab\.com)\/([^/\s]+\/[^/\s]+)\/(?:pull|merge_requests)\/(\d+)(?:[/?#][^\s)]*)?)\)/g

  const matches = [...source.matchAll(pattern)]
  const hasPrimary = matches.some(match => /实际修复|修复候选|当前提案|实际提案|primary/i.test(match[1]))

  for (const match of matches) {
    const [, label, url, repo, number] = match

    // Even a current preamble can explicitly list superseded references.
    if (/历史|旧分支|旧候选|已关闭(?:降级候选|重复)|已替代|已替换|已取代|已废弃|取代的|superseded/.test(label)) {
      continue
    }

    if (hasPrimary && /重复测试|测试刻画|已停止测试|已关闭测试|已取代|superseded/i.test(label)) {
      continue
    }

    const unmerged = /未合并|\bUNMERGED\b|\bNOT\s+MERGED\b/i.test(label)
    const merged = !unmerged && /\bMERGED\b|(?<!未)已合并/i.test(label)
    const closed = /\bCLOSED\b|已关闭/i.test(label)
    const open = !/\bNOT\s+OPEN\b|未开放/i.test(label) && /\bOPEN\b|开放中/i.test(label)

    const state = merged
      ? '已合并'
      : closed
        ? unmerged
          ? '已关闭（未合并）'
          : '已关闭'
        : open
          ? '开放中'
          : '状态待确认'

    const canonical = url.replace(/[?#].*$/, '').replace(/\/$/, '')

    if (!refs.has(canonical)) {
      refs.set(canonical, { url: canonical, repo, number, state })
    }
  }

  return [...refs.values()]
}

function displayStatus(native: string, stage: string): string {
  const fixed: Record<string, string> = { blocked: '受阻', running: '处理中', done: '已完成' }

  if (fixed[native]) {
    return fixed[native]
  }

  if (native === 'review') {
    return stage === '待LGTM' ? '待审核' : '待确认'
  }

  if (native === 'scheduled') {
    return ({ 线上观察: '观察中', 待上线: '待上线' } as Record<string, string>)[stage] ?? '待确认'
  }

  return '待处理'
}

function currentGate(source: string): string {
  const text = plain(currentBody(source))

  if (/(?:^|[。；;，,：:])\s*需恢复原会话/.test(text)) {
    return '恢复原执行会话'
  }

  const clause =
    text.match(/(?:^|[。；;，,：:])\s*((?:等待|还需|尚需|仍需|须由|需要|缺少|仍缺|缺同|需提供)[^。；;\n]+)/)?.[1] ?? ''

  return clause
    .replace(
      /https?:\/\/\S+|[0-9a-f]{8}-[0-9a-f-]{20,}|\b[0-9a-f]{7,40}\b|\b(?:run|session)[-_ ][\w-]+|\blist_turns\b/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function gateFor(body: string, status: string, summary: string): string {
  const explicit = field(body, '还差') || field(body, '下一步') || field(body, '阻塞原因')

  if (explicit) {
    return explicit
  }

  const actual = currentGate(summary) || currentGate(section(body, '验证结果'))

  if (actual) {
    return actual
  }

  const code = field(body, '代码状态')

  if (/(?:打包|assemble)[^。；;]*(?:仍无|缺少|尚未|仍缺|待提供|未通过)/i.test(code)) {
    return /原构建器/.test(body) ? '原构建器提供当前头打包结果' : '提供当前头打包结果'
  }

  if (/(?:最终|负责人)[^。；;]*LGTM[^。；;]*(?:未收到|待确认|尚未)/i.test(code)) {
    return '负责人审核最终代码'
  }

  const online = field(body, '线上状态')

  if (/生产(?:是否)?纳入待确认|生产纳入仍未知/.test(online)) {
    return '确认生产版本包含修复'
  }

  const fallback: Record<string, string> = {
    受阻: '等待补充阻塞所需输入',
    待审核: '负责人审核最终代码',
    待确认: '等待负责人确认',
    待上线: '确认生产版本包含修复',
    观察中: '确认线上观察结果',
    处理中: '等待处理结果',
    已完成: '—'
  }

  return fallback[status] ?? '待补充下一步'
}

export function projectPatrol(tasks: PatrolTask[], details: Record<string, PatrolDetail> = {}): PatrolRow[] {
  const groups = new Map<string, PatrolRow>()

  for (const task of tasks) {
    const body = currentBody(task.body ?? '')
    const title = currentBody(task.title ?? '')

    const project =
      field(body, '项目') ||
      plain(title.match(/^(?:【[^】]+】\s*)?([^｜|]+)[｜|]/)?.[1] ?? task.tenant ?? '') ||
      '待确认项目'

    const problem = field(body, '看板问题') || section(body, '问题描述')
    // Process-heavy titles are not a trustworthy issue summary.
    const cleanTitle = plain(title.replace(/^【[^】]+】\s*/, '').replace(/^[^｜|]+[｜|]/, ''))

    const issueFull =
      problem ||
      (!/#\d|https?:|LGTM|已合并|待上线|验证|测试|打包|HEAD/i.test(cleanTitle) ? cleanTitle : '') ||
      '待补充问题摘要'

    const stage = field(body, '跟踪分组') || title.match(/^【([^】]+)】/)?.[1] || ''
    const status = displayStatus(task.status, stage)
    const gateFull = gateFor(body, status, task.latest_summary ?? '')
    const refs = references(body + '\n' + title)

    // Full problem, exact repository-qualified refs AND gate/native state must agree.
    // Missing evidence never coalesces; helpers remain independently reachable rows.
    const key =
      problem && refs.length && project !== '待确认项目'
        ? JSON.stringify([
            project,
            problem.normalize('NFKC'),
            refs.map(ref => [ref.url, ref.state]).sort(),
            task.status,
            status,
            gateFull
          ])
        : task.id

    const search = [task.id, title, plain(body), project, status, ...refs.map(ref => ref.repo)].join(' ').toLowerCase()
    const existing = groups.get(key)

    if (existing) {
      existing.ids.push(task.id)
      existing.search += ' ' + search
    } else {
      groups.set(key, {
        ids: [task.id],
        project,
        issue: short(issueFull.split(/[。；;]/, 1)[0] || issueFull, 36),
        issueFull,
        status,
        gate: short(gateFull, 32),
        gateFull,
        refs,
        search
      })
    }
  }

  return groupDependencies([...groups.values()], tasks, details)
}

/** Only complete, explicit components with one business problem can absorb helper steps. */
function groupDependencies(rows: PatrolRow[], tasks: PatrolTask[], details: Record<string, PatrolDetail>): PatrolRow[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const graph = new Map(tasks.map(task => [task.id, new Set<string>()]))

  for (const [id, detail] of Object.entries(details)) {
    if (!byId.has(id) || detail.task.id !== id) {
      continue
    }

    for (const linked of [...detail.links.parents, ...detail.links.children]) {
      graph.get(id)!.add(linked)
      graph.get(linked)?.add(id)
    }
  }

  const visited = new Set<string>()
  let result = rows

  for (const task of tasks) {
    if (visited.has(task.id)) {
      continue
    }

    const component = new Set<string>()
    const pending = [task.id]

    while (pending.length) {
      const id = pending.pop()!

      if (component.has(id)) {
        continue
      }

      component.add(id)
      visited.add(id)
      pending.push(...(graph.get(id) ?? []))
    }

    if (component.size < 2 || [...component].some(id => !byId.has(id) || details[id]?.task.id !== id)) {
      continue
    }

    const cards = [...component].map(id => byId.get(id)!)

    const business = cards.filter(card => {
      const body = currentBody(card.body ?? '')

      return Boolean(field(body, '看板问题') || section(body, '问题描述'))
    })

    if (business.length !== 1) {
      continue
    }

    const primary = result.find(row => row.ids.includes(business[0].id))!

    if (primary.refs.length !== 1) {
      continue
    }

    const ref = primary.refs[0]
    const helpers = cards.filter(card => card.id !== business[0].id)

    if (!helpers.every(card => isHelperFor(card, ref))) {
      continue
    }

    const affected = result.filter(row => row.ids.some(id => component.has(id)))

    if (affected.some(row => row.ids.some(id => !component.has(id)))) {
      continue
    }

    const merged = {
      ...primary,
      ids: [business[0].id, ...helpers.map(card => card.id)],
      search: affected.map(row => row.search).join(' '),
      members: cards.map(card => {
        const row = affected.find(row => row.ids.includes(card.id))!

        return { id: card.id, title: short(card.title ?? '原始记录', 36), status: row.status, gate: row.gate }
      })
    }

    result = result.flatMap(row => (row === primary ? [merged] : affected.includes(row) ? [] : [row]))
  }

  return result
}

function isHelperFor(card: PatrolTask, ref: PatrolRef): boolean {
  const body = currentBody(card.body ?? '')
  const text = (card.title ?? '') + '\n' + body
  const refs = references(body)
  const numbers = [...text.matchAll(/#(\d+)\b/g)].map(match => match[1])

  return (
    /(?:^|\n)目标[：:]/.test(body) &&
    /测试|检查|打包|证据|汇总|回写|复核|构建|test|build|summary/i.test(card.title ?? '') &&
    numbers.length > 0 &&
    numbers.every(number => number === ref.number) &&
    refs.every(actual => actual.url === ref.url)
  )
}

export function linkedCohort(tasks: PatrolTask[]): string[] {
  return tasks
    .filter(task => task.link_counts && task.link_counts.parents + task.link_counts.children > 0)
    .map(task => task.id)
    .sort()
}

/** Bounded read-only cohort; incomplete results leave their cards ungrouped. */
export async function loadPatrolDetails(tasks: PatrolTask[], fetchDetail: (id: string) => Promise<PatrolDetail>) {
  const ids = linkedCohort(tasks)

  const results = await Promise.allSettled(
    ids.slice(0, 16).map(async id => {
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        const detail = await Promise.race([
          fetchDetail(id),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Linked record timed out')), 8000)
          })
        ])

        if (detail.task.id !== id || !Array.isArray(detail.links?.parents) || !Array.isArray(detail.links?.children)) {
          throw new Error('Invalid linked record')
        }

        return [id, detail] as const
      } finally {
        clearTimeout(timer)
      }
    })
  )

  const details = Object.fromEntries(results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : [])))

  return { details, unavailable: ids.length > 16 || results.some(result => result.status === 'rejected') }
}

/** Authored current facts only: never promote narrative/history into drawer facts. */
function authoredField(body: string, name: string): string {
  const prefix = new RegExp(`^\\s*(?:[-*]\\s+)?(\\*\\*)?${name}(\\*\\*)?\\s*[：:]`)

  for (const line of body.split('\n')) {
    const match = line.match(prefix)

    if (!match) {continue}
    const value = line.slice(match[0].length)

    return (match[1] && !match[2] ? value.replace(/^\s*\*\*/, '') : value).trim()
  }

  return ''
}

function currentText(full: string, limit: number): { text: string; full: string } {
  // Cropping a later negation or qualification would change the authored meaning.
  return { full, text: Array.from(full).length <= limit ? full : '字段较长，请展开历史与技术记录查看完整内容' }
}

export function projectPatrolCurrent(task: PatrolTask) {
  const body = currentBody(task.body ?? '')
  const status = displayStatus(task.status, field(body, '跟踪分组') || task.title?.match(/^【([^】]+)】/)?.[1] || '')

  const conclusions: Record<string, string> = {
    受阻: '当前处理受阻，具体结论待补充',
    处理中: '正在处理，具体结论待补充',
    已完成: '原任务已完成，具体结论待补充',
    待处理: '尚待处理，具体结论待补充',
    待审核: '等待审核，具体结论待补充',
    待上线: '等待上线，具体结论待补充',
    观察中: '正在观察，具体结论待补充'
  }

  const next: Record<string, string> = {
    受阻: '待补充解除阻塞所需的下一步',
    待审核: '等待负责人确认审核结果',
    待上线: '确认上线安排与验证结果',
    观察中: '确认观察结果',
    已完成: '待确认是否仍有后续事项'
  }

  const facts = [
    ['当前结论', authoredField(body, '当前结论') || conclusions[status] || '当前结论待确认'],
    ['下一步', authoredField(body, '下一步') || authoredField(body, '还差') || next[status] || '下一步待补充'],
    ['负责方', authoredField(body, '负责方') || '负责方待确认'],
    ['需要你', authoredField(body, '需要你') || '待明确是否需要你处理']
  ].map(([label, full]) => ({ label, ...currentText(full, 80) }))

  const preamble = body.split('\n').find(line => /^\s*PR\s*[：:]/i.test(line.replace(/\*\*/g, '')))

  return {
    title: currentText(authoredField(body, '看板问题') || authoredField(body, '当前事项') || '待补充问题摘要', 36),
    status,
    facts,
    refs: references(preamble ?? '').slice(0, 1)
  }
}
