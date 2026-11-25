// One-sided paired score test on the trinomial counts (harm, gain, concordant).
export function belowMargin(n,harm,gain,margin) {
  const observed=(harm-gain)/n;
  if (observed>=margin) return false;
  const discordant=harm+gain;
  const b=discordant+(harm-gain)*margin;
  const c=(gain-harm)*margin+(n-discordant)*margin**2;
  // Constrained maximum likelihood for q=P(discordant), at fixed risk difference.
  const q=Math.max(Math.abs(margin),Math.min(1,(b+Math.sqrt(Math.max(0,b*b+4*n*c)))/(2*n)));
  return margin-observed>1.6448536269514722*Math.sqrt(Math.max(0,q-margin**2)/n);
}

export function upperNet(n,harm,gain) {
  let lo=(harm-gain)/n,hi=1;
  for(let i=0;i<55;i++) {
    const mid=(lo+hi)/2;
    if(belowMargin(n,harm,gain,mid)) hi=mid;
    else lo=mid;
  }
  return hi;
}
