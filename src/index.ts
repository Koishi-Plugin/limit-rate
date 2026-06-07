import { Argv, Computed, Context, Schema, Command, Logger } from 'koishi'

interface UsageRecord {
  lastUsedAt?: number
  dailyCount: number
  lastResetDay: string
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
  debugMode?: boolean
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
  debugMode: Schema.boolean().default(false).description('调试输出'),
})

export function apply(ctx: Context, config: Config) {
  const commandRecords = new WeakMap<Command, Record<'platform' | 'channel' | 'user', Map<string, UsageRecord>>>()

  ctx.schema.extend('command', Schema.object({
    scope: Schema.union([
      Schema.const('platform').description('平台'),
      Schema.const('channel').description('频道'),
      Schema.const('user').description('用户'),
    ]).default('channel').description('频率限制范围'),
    maxDayUsage: Schema.computed(Schema.number()).default(0).description('每日次数限制'),
    minInterval: Schema.computed(Schema.number()).default(0).description('连续调用间隔'),
  }), 800)

  ctx.before('command/execute', (argv: Argv) => {
    const { session, command } = argv
    if (!session?.userId || !command) return
    // 获取配置
    const minInterval = session.resolve(command.config.minInterval) ?? 0
    const maxDayUsage = session.resolve(command.config.maxDayUsage) ?? 0
    if (minInterval <= 0 && maxDayUsage <= 0) return
    // 初始化记录
    if (!commandRecords.has(command)) {
      commandRecords.set(command, {
        platform: new Map(),
        channel: new Map(),
        user: new Map(),
      })
    }
    // 获取标识
    const scope = session.resolve(command.config.scope) ?? 'channel'
    const targetId = scope === 'user' ? session.uid : (scope === 'channel' ? session.cid : session.platform)
    const recordMap = commandRecords.get(command)![scope]
    const now = Date.now()
    const today = new Date().toISOString().slice(0, 10)
    let record = recordMap.get(targetId)
    // 重置记录
    if (!record) {
      record = { dailyCount: 0, lastResetDay: today }
      recordMap.set(targetId, record)
    } else if (record.lastResetDay !== today) {
      record.dailyCount = 0
      record.lastResetDay = today
    }
    if (config.debugMode) logger.info(`[${command.name}] ${session.userId} 正在执行指令`)
    // 校验冷却间隔
    if (minInterval > 0 && record.lastUsedAt) {
      const cooldownTime = record.lastUsedAt + minInterval * 1000
      if (cooldownTime > now) {
        const remaining = Math.ceil((cooldownTime - now) / 1000)
        if (config.debugMode) logger.info(`[${command.name}] 触发 ${remaining}s 冷却`)
        return config.sendHint ? `操作过于频繁，请等 ${remaining} 秒后重试` : ''
      }
    }
    // 校验每日上限
    if (maxDayUsage > 0 && record.dailyCount >= maxDayUsage) {
      if (config.debugMode) logger.info(`[${command.name}] 触发今日上限`)
      return config.sendHint ? `今日使用 ${command.name} 达到上限，请明日再试` : ''
    }
    // 更新并执行指令
    if (config.debugMode) {
      const lastUsedStr = record.lastUsedAt ? new Date(record.lastUsedAt).toLocaleString() : '无'
      logger.info(`[${command.name}] 状态: 范围:${scope} | 已用 ${record.dailyCount}/${maxDayUsage} | 上次: ${lastUsedStr}`)
    }
    record.lastUsedAt = now
    if (maxDayUsage > 0) record.dailyCount++
  })
}
