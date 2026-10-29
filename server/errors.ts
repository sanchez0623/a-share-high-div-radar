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

/** 风险核验文件损坏或不可读：必须 fail-closed，禁止回退演示数据。 */
export class RiskPersistenceError extends Error {
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
