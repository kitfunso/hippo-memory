import urllib.request,re,html
urls=['https://arxiv.org/html/2603.22455v5','https://arxiv.org/html/2605.22057v2']
pats=['1.78','2.33','coding agent','task success','72.57','78.04','89.83','17.26']
out=[]
for u in urls:
    out.append('URL '+u)
    s=urllib.request.urlopen(u,timeout=30).read().decode('utf-8','ignore')
    t=html.unescape(re.sub(r'<[^>]+>',' ',s))
    t=re.sub(r'\s+',' ',t)
    for p in pats:
        i=t.lower().find(p.lower())
        if i>=0: out.append(p+': '+t[max(0,i-180):i+380])
open('research\\_paper_snippets.txt','w',encoding='utf-8').write('\n\n'.join(out))
