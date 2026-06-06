import { Argv, Computed, Context, Schema, Command, Logger } from 'koishi'

interface UsageRecord {
  lastUsedAt?: number
  dailyCount?: number
  lastResetDay?: string
}

interface CommandFilterRule {
  type: 'user' | 'channel'
  content: string
  action: 'block' | 'ignore'
}

declare module 'koishi' {
  namespace Command {
    interface Config {
      maxDayUsage?: Computed<number>
      minInterval?: Computed<number>
      scope?: Computed<'platform' | 'channel' | 'user'>
    }
  }
}

export interface Config {
  sendHint?: boolean
  commandRules?: CommandFilterRule[]
}

const logger = new Logger('limit-rate')

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
  sendHint: Schema.boolean().default(false).description('发送提示'),
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

export function apply(ctx: Context, config: Config) {
  const commandRecords = new Map<string, UsageRecord>()

  ctx.schema.extend('command', Schema.object({
    scope: Schema.union([
      Schema.const('platform').description('平台'),
      Schema.const('channel').description('频道'),
      Schema.const('user').description('用户'),
    ]).default('channel').description('频率限制范围'),
    maxDayUsage: Schema.computed(Schema.number()).default(0).description('每日次数限制'),
    minInterval: Schema.computed(Schema.number()).default(0).description('连续调用间隔'),
  }), 800)

  ctx.middleware((session, next) => {
    const action = config.commandRules?.find(rule =>
      (rule.type === 'user' && rule.content === session.userId) ||
      (rule.type === 'channel' && rule.content === session.channelId)
    )?.action
    if (action === 'block') {
      logger.info(`[${session.userId || session.channelId}] 中间件已拦截`)
      return
    }
    return next()
  }, true)


  ctx.before('command/execute', (argv: Argv) => {
    const { session, command } = argv
    if (!session?.userId || !command) return
    const { userId, channelId, platform } = session
    const action = config.commandRules?.find(rule =>
      (rule.type === 'user' && rule.content === userId) ||
      (rule.type === 'channel' && rule.content === channelId)
    )?.action ?? 'limit'
    if (action === 'ignore') return
    if (action === 'block') return ''
    logger.info(`[${command.name}] ${userId} 触发指令: ${action}`)
    const now = Date.now()
    const today = new Date().toISOString().slice(0, 10)
    let cmd: Command | undefined = command
    while (cmd) {
      const minInterval = session.resolve(cmd.config.minInterval) ?? 0
      const maxDayUsage = session.resolve(cmd.config.maxDayUsage) ?? 0
      if (minInterval > 0 || maxDayUsage > 0) {
        const scope = session.resolve(cmd.config.scope) ?? 'channel'
        const key = scope === 'user' ? userId : scope === 'channel' ? channelId : platform
        if (key) {
          const recordId = `${scope}:${key}:${cmd.name}`
          const record = commandRecords.get(recordId) ?? { dailyCount: 0, lastResetDay: today }
          record.dailyCount ??= 0
          record.lastResetDay ??= today
          if (minInterval > 0 && record.lastUsedAt) {
            const cooldownTime = record.lastUsedAt + minInterval * 1000
            if (cooldownTime > now) {
              const remaining = Math.ceil((cooldownTime - now) / 1000)
              logger.info(`[${cmd.name}] 触发 ${remaining}s 冷却`)
              return config.sendHint ? `操作过于频繁，请等 ${remaining} 秒后重试` : ''
            }
          }
          if (maxDayUsage > 0) {
            if (record.lastResetDay !== today) {
              record.lastResetDay = today
              record.dailyCount = 0
            }
            if (record.dailyCount >= maxDayUsage) {
              logger.info(`[${cmd.name}] 触发上限`)
              return config.sendHint ? `今日使用 ${cmd.name} 达到上限，请明日再试` : ''
            }
          }
          record.lastUsedAt = now
          if (maxDayUsage > 0) record.dailyCount++
          commandRecords.set(recordId, record)
        }
      }
      cmd = cmd.parent
    }
  })
}
