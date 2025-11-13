import { Argv, Computed, Context, Schema, Session, Command } from 'koishi'

/** 频率限制的作用范围 */
type Scope = 'platform' | 'channel' | 'user'
/** 对用户或频道的具体行为 */
type Action = 'block' | 'limit' | 'ignore'

/**
 * 存储指令使用情况的记录
 */
interface UsageRecord {
  /** 冷却到期时间戳 */
  cooldownExpiresAt?: number
  /** 当日剩余使用次数 */
  dailyUsesLeft?: number
  /** 当日使用次数重置时间戳 */
  dailyResetAt?: number
}

/**
 * 指令过滤规则，用于设置豁免（白名单）或限制（黑名单）
 */
interface CommandFilterRule {
  /** 规则应用的类型 */
  type: 'user' | 'channel'
  /** 规则应用的目标 ID (用户 ID 或频道 ID) */
  content: string
  /** 对目标执行的行为 */
  action: 'block' | 'ignore'
}

declare module 'koishi' {
  namespace Command {
    interface Config {
      /* 每日最大使用次数 */
      maxDayUsage?: Computed<number>
      /* 最小调用间隔 */
      minInterval?: Computed<number>
      /* 频率限制的生效范围 */
      scope?: Computed<Scope>
    }
  }
}

export interface Config {
  /** 是否在触发频率限制时发送提示 */
  sendHint?: boolean
  /** 指令过滤的例外规则列表 */
  commandRules?: CommandFilterRule[]
}

export const name = 'rate-limit'

export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

export const Config: Schema<Config> = Schema.object({
  sendHint: Schema.boolean().default(false).description('发送限流提示'),
  commandRules: Schema.array(Schema.object({
    type: Schema.union([
      Schema.const('user').description('用户'),
      Schema.const('channel').description('频道'),
    ]).default('user').description('类型'),
    content: Schema.string().description('ID').required(),
    action: Schema.union([
      Schema.const('block').description('限制'),
      Schema.const('ignore').description('豁免'),
    ]).default('ignore').description('行为'),
  })).role('table').description('例外规则'),
})

/**
 * 插件主逻辑
 * @param ctx Koishi 上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const commandRecords = new Map<string, UsageRecord>()
  const rules = new Map<string, Action>()

  for (const rule of config.commandRules ?? []) rules.set(`${rule.type}:${rule.content}`, rule.action)

  // 扩展指令配置项
  ctx.schema.extend('command', Schema.object({
    scope: Schema.computed(Schema.union([
      Schema.const('platform').description('平台'),
      Schema.const('channel').description('频道'),
      Schema.const('user').description('用户'),
    ])).default('channel').description('频率限制范围'),
    maxDayUsage: Schema.computed(Schema.number()).default(0).description('每日次数限制'),
    minInterval: Schema.computed(Schema.number()).default(0).description('连续调用间隔 (秒)'),
  }), 800)

  /**
   * 根据会话和作用范围生成唯一的记录键
   * @param session 当前会话
   * @param scope 作用范围
   * @returns 记录键 (string) 或 undefined
   */
  function getRecordKey(session: Session, scope: Scope): string | undefined {
    switch (scope) {
      case 'user': return session.userId
      case 'channel': return session.channelId
      case 'platform': return session.platform
      default: return undefined
    }
  }

  /**
   * 检查并更新指令的调用频率和次数
   * @param session 当前会话
   * @param commandName 指令名称
   * @param scope 作用范围
   * @param minInterval 最小调用间隔
   * @param maxDayUsage 每日最大使用次数
   * @returns 如果被限流，则返回提示信息；否则返回 undefined
   */
  function checkRateLimit(session: Session, commandName: string, scope: Scope, minInterval: number, maxDayUsage: number): string | undefined {
    const key = getRecordKey(session, scope)
    if (!key) return

    const recordId = `${scope}:${key}:${commandName}`
    const now = Date.now()
    const record = commandRecords.get(recordId) ?? {}

    // 检查冷却时间
    if (minInterval > 0 && record.cooldownExpiresAt && record.cooldownExpiresAt > now) {
      const remaining = Math.ceil((record.cooldownExpiresAt - now) / 1000)
      return `操作过于频繁，请 ${remaining} 秒后重试`
    }

    // 检查每日使用次数
    if (maxDayUsage > 0) {
      if (!record.dailyResetAt || now > record.dailyResetAt) {
        const tomorrow = new Date()
        tomorrow.setHours(24, 0, 0, 0)
        record.dailyResetAt = tomorrow.getTime()
        record.dailyUsesLeft = maxDayUsage
      }
      if (record.dailyUsesLeft <= 0) return `使用已达上限，请明日再试`
    }

    // 更新记录
    if (minInterval > 0) record.cooldownExpiresAt = now + minInterval * 1000
    if (maxDayUsage > 0) record.dailyUsesLeft--
    commandRecords.set(recordId, record)
    return undefined
  }

  /**
   * 根据配置的规则获取对当前会话生效的行为
   * @param session 当前会话
   * @returns 'block' (阻止), 'ignore' (忽略限制), 或 'limit' (应用限制)
   */
  function getEffectiveAction(session: Session): Action {
    return rules.get(`user:${session.userId}`)
      ?? rules.get(`channel:${session.channelId}`)
      ?? 'limit'
  }

  // 在指令执行前进行前置处理
  ctx.before('command/execute', (argv: Argv) => {
    const { session, command } = argv
    const action = getEffectiveAction(session)

    // 如果规则为 'ignore'，则直接跳过所有限制
    if (action === 'ignore') return
    // 如果规则为 'block'，则直接阻止指令执行
    if (action === 'block') return ''

    // 遍历指令及其父指令，检查是否配置了频率限制
    for (let cmd: Command = command; cmd; cmd = cmd.parent) {
      const minInterval = session.resolve(cmd.config.minInterval)
      const maxDayUsage = session.resolve(cmd.config.maxDayUsage)
      if (!minInterval && !maxDayUsage) continue

      const scope = session.resolve(cmd.config.scope)
      const name = cmd.name.replace(/\./g, ':')
      const result = checkRateLimit(session, name, scope, minInterval, maxDayUsage)

      // 如果触发限流，则根据配置决定是否发送提示
      if (result) return config.sendHint ? result : ''
    }
  })
}
