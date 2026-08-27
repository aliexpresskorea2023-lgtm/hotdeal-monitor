import type { PricePoint } from "@/src/db/history";

/*
 * 가격 관측 스파크라인. 값 자체를 읽는 그래프가 아니라
 * "어떻게 움직였는지"를 한눈에 주는 보조 표시 —
 * 정확한 수치는 옆의 현재가/최저가 숫자가 담당한다.
 */

const WIDTH = 132;
const HEIGHT = 34;
const PAD = 3;

export function PriceSpark({ points }: { points: PricePoint[] }) {
  const values = points
    .map((point) => point.price)
    .filter((price): price is number => price !== null);

  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (WIDTH - PAD * 2) / (values.length - 1);

  const coords = values.map((value, index) => {
    const x = PAD + index * step;
    const y =
      HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2);

    return { x, y };
  });

  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${PAD},${HEIGHT - PAD} ${line} ${(PAD + (values.length - 1) * step).toFixed(1)},${HEIGHT - PAD}`;
  const last = coords[coords.length - 1];
  const falling = values[values.length - 1] <= values[0];

  return (
    <svg
      className={falling ? "spark down" : "spark up"}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={`관측 ${values.length}회, ${falling ? "가격 인하" : "가격 인상"} 추이`}
    >
      <polygon className="spark-area" points={area} />
      <polyline className="spark-line" points={line} />
      <circle className="spark-dot" cx={last.x} cy={last.y} r={2.6} />
    </svg>
  );
}
