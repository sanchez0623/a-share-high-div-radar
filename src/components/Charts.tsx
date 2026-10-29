import type { DividendRecord, Portfolio, PriceBar, Stock } from '../../shared/types.ts';
import { money, number, percent, shortSymbol } from '../format.ts';

const linePath = (values: number[], width: number, height: number, padding = 2) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((value, index) => {
      const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
};

export function Sparkline({ values, positive = false }: { values: number[]; positive?: boolean }) {
  return (
    <svg className="sparkline" viewBox="0 0 160 48" role="img" aria-label="近30日价格走势">
      <path d={linePath(values, 160, 48, 4)} fill="none" stroke={positive ? '#ef7456' : 'currentColor'} strokeWidth="2" />
      <circle
        cx="156"
        cy={(() => {
          const min = Math.min(...values);
          const max = Math.max(...values);
          return 44 - ((values.at(-1)! - min) / (max - min || 1)) * 40;
        })()}
        r="3"
        fill={positive ? '#ef7456' : 'currentColor'}
      />
    </svg>
  );
}

export function OpportunityMap({ stocks, onSelect }: { stocks: Stock[]; onSelect: (symbol: string) => void }) {
  const width = 760;
  const height = 280;
  const left = 48;
  const right = 28;
  const top = 20;
  const bottom = 42;
  const minYield = Math.max(0, Math.floor(Math.min(...stocks.map((s) => s.dividendYield)) - 1));
  const maxYield = Math.ceil(Math.max(...stocks.map((s) => s.dividendYield)) + 1);
  const x = (value: number) => left + ((value - minYield) / (maxYield - minYield || 1)) * (width - left - right);
  const y = (value: number) => top + (1 - Math.max(0, Math.min(1, value))) * (height - top - bottom);
  const threshold = stocks.reduce((sum, stock) => sum + stock.buyThreshold, 0) / stocks.length;
  const sweetX = x(threshold);
  const sweetY = y(0.2);

  return (
    <div className="opportunity-map-wrap">
      <svg className="opportunity-map" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="股息率与布林位置机会坐标">
        <rect x={sweetX} y={sweetY} width={width - right - sweetX} height={height - bottom - sweetY} rx="14" className="sweet-zone" />
        <text x={width - right - 12} y={height - bottom - 12} textAnchor="end" className="zone-label">研究甜区</text>
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="chart-grid" />
            <text x={left - 12} y={y(tick) + 4} textAnchor="end" className="axis-label">{tick * 100}%</text>
          </g>
        ))}
        {Array.from({ length: maxYield - minYield + 1 }, (_, index) => minYield + index).map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} x2={x(tick)} y1={top} y2={height - bottom} className="chart-grid" />
            <text x={x(tick)} y={height - 16} textAnchor="middle" className="axis-label">{tick}%</text>
          </g>
        ))}
        <line x1={sweetX} x2={sweetX} y1={top} y2={height - bottom} className="threshold-line" />
        <line x1={left} x2={width - right} y1={sweetY} y2={sweetY} className="threshold-line" />
        <text x={left} y={12} className="axis-title">%B 位置 ↑</text>
        <text x={width - right} y={height - 16} textAnchor="end" className="axis-title">预测股息率 →</text>
        {stocks.map((stock, index) => {
          const cx = x(stock.dividendYield);
          const cy = y(stock.percentB);
          const labelBelow = cy < 70;
          return (
            <g
              key={stock.symbol}
              className="map-stock"
              role="button"
              tabIndex={0}
              aria-label={`查看${stock.name}，股息率${percent(stock.dividendYield)}`}
              onClick={() => onSelect(stock.symbol)}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onSelect(stock.symbol)}
              style={{ '--delay': `${index * 80}ms` } as React.CSSProperties}
            >
              <circle cx={cx} cy={cy} r={stock.level === 'L0' ? 18 : 24} className={`map-dot map-${stock.level.toLowerCase()}`} />
              <text x={cx} y={cy + 4} textAnchor="middle" className="map-level">{stock.level}</text>
              <text x={cx} y={cy + (labelBelow ? 40 : -32)} textAnchor="middle" className="map-name">{stock.name}</text>
              <text x={cx} y={cy + (labelBelow ? 55 : -18)} textAnchor="middle" className="map-value">{percent(stock.dividendYield)}</text>
            </g>
          );
        })}
      </svg>
      <div className="map-caption">
        <span><i className="legend-dot legend-sweet" />越靠右下，估值与价格位置越接近研究区</span>
        <span>点选气泡进入个股透视</span>
      </div>
    </div>
  );
}

export function PriceChart({ history, stock }: { history: PriceBar[]; stock: Stock }) {
  const bars = history.slice(-60);
  const full = history;
  const width = 820;
  const height = 340;
  const left = 18;
  const right = 62;
  const top = 24;
  const bottom = 38;
  const bands = full.map((_, index) => {
    if (index < 19) return null;
    const values = full.slice(index - 19, index + 1).map((bar) => bar.close);
    const mid = values.reduce((sum, value) => sum + value, 0) / 20;
    const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mid) ** 2, 0) / 20);
    return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd };
  }).slice(-60);
  const visible = bars.map((bar, index) => ({ close: bar.close, ...bands[index] }));
  const values = visible.flatMap((item) => [item.close, item.upper ?? item.close, item.lower ?? item.close]);
  const min = Math.min(...values) * 0.995;
  const max = Math.max(...values) * 1.005;
  const x = (index: number) => left + (index / (bars.length - 1)) * (width - left - right);
  const y = (value: number) => top + ((max - value) / (max - min || 1)) * (height - top - bottom);
  const pathFor = (key: 'close' | 'mid' | 'upper' | 'lower') =>
    visible.map((item, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(item[key] ?? item.close)}`).join(' ');

  return (
    <div className="price-chart-wrap">
      <div className="chart-legend">
        <span><i className="legend-line close-line" />收盘价</span>
        <span><i className="legend-line mid-line" />MA20</span>
        <span><i className="legend-line band-line" />布林带 ±2σ</span>
      </div>
      <svg className="price-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${stock.name}近60日价格与布林带`}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = max - ratio * (max - min);
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="chart-grid" />
              <text x={width - right + 10} y={y(value) + 4} className="axis-label">{value.toFixed(2)}</text>
            </g>
          );
        })}
        <path d={`${pathFor('upper')} L${x(visible.length - 1)},${y(visible.at(-1)!.lower ?? 0)} ${visible.slice().reverse().map((item, reverseIndex) => `L${x(visible.length - 1 - reverseIndex)},${y(item.lower ?? item.close)}`).join(' ')} Z`} className="boll-area" />
        <path d={pathFor('upper')} className="band-path" />
        <path d={pathFor('lower')} className="band-path" />
        <path d={pathFor('mid')} className="mid-path" />
        <path d={pathFor('close')} className="close-path" />
        <line x1={left} x2={width - right} y1={y(stock.price)} y2={y(stock.price)} className="current-line" />
        <circle cx={x(visible.length - 1)} cy={y(stock.price)} r="5" className="current-dot" />
        <text x={left} y={height - 12} className="axis-label">{bars[0].date.slice(5)}</text>
        <text x={width - right} y={height - 12} textAnchor="end" className="axis-label">{bars.at(-1)!.date.slice(5)}</text>
      </svg>
    </div>
  );
}

export function DividendBars({ dividends }: { dividends: DividendRecord[] }) {
  const max = Math.max(...dividends.map((item) => item.dividend));
  return (
    <div className="dividend-bars" role="img" aria-label="历年每股分红记录">
      {dividends.map((item) => (
        <div className="dividend-bar-item" key={item.year}>
          <span className="dividend-bar-value">¥{number(item.dividend)}</span>
          <div className="dividend-bar-track">
            <div className="dividend-bar" style={{ height: `${Math.max(12, (item.dividend / max) * 100)}%` }} />
          </div>
          <strong>{item.year}</strong>
          <span>{item.growth === 0 ? '基期' : percent(item.growth, 1)}</span>
        </div>
      ))}
    </div>
  );
}

export function ScoreRing({ score }: { score: number }) {
  const radius = 36;
  const circumference = Math.PI * 2 * radius;
  return (
    <div className="score-ring" aria-label={`机会关注分${score}分`}>
      <svg viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={radius} className="score-track" />
        <circle cx="44" cy="44" r={radius} className="score-progress" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - score / 100)} />
      </svg>
      <div><strong>{score}</strong><span>关注分</span></div>
    </div>
  );
}

export function PortfolioDonut({ portfolio }: { portfolio: Portfolio }) {
  const items = [
    ...portfolio.positions.map((position) => ({ name: position.name, value: position.marketValue, color: '#d8f28a' })),
    { name: '现金', value: portfolio.cash, color: '#76988a' },
  ];
  const radius = 54;
  const circumference = Math.PI * 2 * radius;
  let offset = 0;
  return (
    <div className="portfolio-donut">
      <svg viewBox="0 0 140 140" role="img" aria-label="组合资产配置">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#2b4b41" strokeWidth="18" />
        {items.map((item) => {
          const fraction = item.value / portfolio.totalAssets;
          const dash = fraction * circumference;
          const circle = (
            <circle
              key={item.name}
              cx="70"
              cy="70"
              r={radius}
              fill="none"
              stroke={item.color}
              strokeWidth="18"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            />
          );
          offset += dash;
          return circle;
        })}
      </svg>
      <div><strong>{money(portfolio.totalAssets, 0)}</strong><span>总资产</span></div>
    </div>
  );
}

export function MiniStockCode({ stock }: { stock: Stock }) {
  return <span className="mini-stock-code">{stock.market} · {shortSymbol(stock.symbol)}</span>;
}
