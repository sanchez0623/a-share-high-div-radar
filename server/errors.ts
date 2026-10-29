export class TradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeError';
  }
}

export class AssumptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssumptionError';
  }
}

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

/**
 * 持久化文件损坏或不可读：必须 fail-closed，禁止回退演示数据后覆盖原文件。
 * 各存储特化子类保留名称便于测试与启动引导，启动层统一按本基类拒绝启动。
 */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

/** 风险核验文件损坏或不可读：必须 fail-closed，禁止回退演示数据。 */
export class RiskPersistenceError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = 'RiskPersistenceError';
  }
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}
