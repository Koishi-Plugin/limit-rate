import { Argv, Computed, Context, Schema, Session, Command } from 'koishi'

// 扩展指令配置项
declare module 'koishi' {
  namespace Command {
    interface Config {
      maxUsage?: Computed<number>
      minInterval?: Computed<number>
    }
  }
}

// 使用记录的接口
interface UsageRecord {
  cooldownExpiresAt?: number
  dailyUsesLeft?: number
  dailyResetAt?: number
}

// 指令规则接口
interface CommandFilterRule {
  type: 'user' | 'channel'
  content: string
}

// 中间件限制规则接口
interface MiddlewareLimitRule {
  content: string
  maxUsage?: number
  minInterval?: number
}

// 中间件规则接口
interface CompiledMiddlewareRule extends MiddlewareLimitRule {
  regex: RegExp
}

// 插件主配置项
export interface Config {
  scope?: 'user' | 'channel' | 'global'
  sendHint?: boolean
  // 指令相关配置
  defaultAction?: 'limit' | 'ignore'
  commandRules?: CommandFilterRule[]
  // 中间件相关配置
  limitMiddleware?: boolean
  middlewareRules?: MiddlewareLimitRule[]
}

// 插件说明和支持信息
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

export const name = 'rate-limit'

// 配置项 Schema 定义
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    scope: Schema.union([
      Schema.const('user').description('用户'),
      Schema.const('channel').description('频道'),
      Schema.const('global').description('全局'),
    ]).default('user').description('频率限制范围'),
    sendHint: Schema.boolean().default(false).description('发送消息提示'),
  }).description('基础设置'),
  Schema.object({
    defaultAction: Schema.union([
      Schema.const('limit').description('限制'),
      Schema.const('ignore').description('豁免'),
    ]).default('limit').description('默认行为'),
    commandRules: Schema.array(Schema.object({
      type: Schema.union([
        Schema.const('user').description('用户 ID'),
        Schema.const('channel').description('频道 ID'),
      ]).default('user').description('类型'),
      content: Schema.string().description('内容'),
    })).role('table').description('例外列表'),
  }).description('指令限制'),
  Schema.object({
    limitMiddleware: Schema.boolean().default(false).description('限制非指令频率'),
    middlewareRules: Schema.array(Schema.object({
      content: Schema.string().description('匹配正则'),
      maxUsage: Schema.number().default(0).description('每日次数限制'),
      minInterval: Schema.number().default(5).description('连续调用间隔（秒）'),
    })).role('table').description('规则列表'),
  }).description('中间件限制')
])

export function apply(ctx: Context, config: Config) {
  const commandRecords = new Map<string, Map<string, UsageRecord>>()
  const middlewareRecords = new Map<string, Map<string, UsageRecord>>()

  const userRuleSet = new Set<string>()
  const channelRuleSet = new Set<string>()
  for (const rule of (config.commandRules || [])) {
    if (rule.type === 'user') {
      userRuleSet.add(rule.content)
    } else {
      channelRuleSet.add(rule.content)
    }
  }

  const compiledMiddlewareRules: CompiledMiddlewareRule[] = (config.middlewareRules || []).map(rule => {
    try {
      return { ...rule, regex: new RegExp(rule.content) }
    } catch (e) {
      ctx.logger.warn(`无效正则表达式"${rule.content}": ${e.message}`)
      return null
    }
  }).filter(Boolean)

  ctx.schema.extend('command', Schema.object({
    maxUsage: Schema.computed(Schema.number()).default(0).description('每日次数限制'),
    minInterval: Schema.computed(Schema.number()).default(0).description('连续调用间隔（秒）'),
  }), 800)

  /**
   * 核心检查函数，处理冷却和使用次数
   * @returns 若被限流则返回提示字符串，否则返回 undefined
   */
  function checkRateLimit(records: Map<string, Map<string, UsageRecord>>, session: Session, scope: 'user' | 'channel' | 'global', name: string, minInterval: number, maxUsage: number): string | undefined {
    if (!minInterval && !maxUsage) return

    // 确定记录ID
    const recordId = scope === 'global' ? 'global' : `${scope}:${scope === 'user' ? session.userId : session.channelId}`
    if (scope !== 'global' && !recordId.split(':')[1]) return

    const now = Date.now()

    let userOrChannelRecords = records.get(recordId)
    if (!userOrChannelRecords) records.set(recordId, userOrChannelRecords = new Map())

    let record = userOrChannelRecords.get(name)
    if (!record) userOrChannelRecords.set(name, record = {})

    // 检查冷却时间
    if (minInterval > 0 && record.cooldownExpiresAt && now < record.cooldownExpiresAt) {
      const remaining = Math.ceil((record.cooldownExpiresAt - now) / 1000)
      return `操作过于频繁，请在 ${remaining} 秒后重试`
    }

    // 检查每日使用次数
    if (maxUsage > 0) {
      if (!record.dailyResetAt || now > record.dailyResetAt) {
        record.dailyUsesLeft = maxUsage
        const tomorrow = new Date()
        tomorrow.setHours(24, 0, 0, 0)
        record.dailyResetAt = tomorrow.getTime()
      }
      if (record.dailyUsesLeft <= 0) {
        return `今日使用次数已达上限`
      }
    }

    // 更新记录
    if (minInterval > 0) record.cooldownExpiresAt = now + minInterval * 1000
    if (maxUsage > 0) record.dailyUsesLeft--
  }

  // 指令执行前检查
  ctx.before('command/execute', ({ session, command }: Argv) => {
    const isMatch = userRuleSet.has(session.userId) || channelRuleSet.has(session.channelId)
    const shouldLimit = (config.defaultAction === 'limit') !== isMatch
    if (!shouldLimit) return

    const minInterval = session.resolve(command.config.minInterval)
    const maxUsage = session.resolve(command.config.maxUsage)
    if (!minInterval && !maxUsage) return

    let effectiveCommand: Command = command
    while (effectiveCommand.parent) {
      const currentMinInterval = session.resolve(effectiveCommand.config.minInterval)
      const currentMaxUsage = session.resolve(effectiveCommand.config.maxUsage)
      const parentMinInterval = session.resolve(effectiveCommand.parent.config.minInterval)
      const parentMaxUsage = session.resolve(effectiveCommand.parent.config.maxUsage)

      if (currentMinInterval === parentMinInterval && currentMaxUsage === parentMaxUsage) {
        effectiveCommand = effectiveCommand.parent
      } else {
        break
      }
    }
    const name = effectiveCommand.name.replace(/\./g, ':')
    const result = checkRateLimit(commandRecords, session, config.scope, name, minInterval, maxUsage)

    if (result) return config.sendHint ? result : ''
  })

  // 中间件处理
  if (config.limitMiddleware) {
    ctx.middleware((session, next) => {
      if (!compiledMiddlewareRules.length || session.argv || !session.content) return next()

      for (let i = 0; i < compiledMiddlewareRules.length; i++) {
        const rule = compiledMiddlewareRules[i]
        if (rule.regex.test(session.content)) {
          const result = checkRateLimit(middlewareRecords, session, config.scope, `middleware-rule:${i}`, rule.minInterval, rule.maxUsage)
          if (result !== undefined) {
            // 一旦被任何一个规则限流，立即返回结果
            return config.sendHint ? result : ''
          }
        }
      }
      return next()
    }, true)
  }
}
