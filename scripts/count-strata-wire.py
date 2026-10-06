#!/usr/bin/env python3
"""Offline exact text-only Strata frontend/template/tokenizer counting."""
import sys,json,pathlib,hashlib,os
STRATA=pathlib.Path(os.environ['STRATA_REPO']).expanduser().resolve()
sys.path[:0]=[str(STRATA),str(STRATA/'tools')]
from serve.frontend import ChatTemplate,openai_to_messages
import strata_tokenizer as ST
root=pathlib.Path(os.environ['STRATA_TOKENIZER_DIR']).expanduser().resolve()
vocab=json.loads((root/'vocab.json').read_text());tokens=[None]*len(vocab)
for t,i in vocab.items():tokens[i]=t
tok=ST.Tokenizer(tokens,(root/'merges.txt').read_text().split('\n'),json.loads((root/'token_type.json').read_text()))
template=ChatTemplate(root/'chat_template.jinja')
def count(body):
 messages,tools,kw=openai_to_messages(body)
 text=template.render(messages,tools=tools,**kw)
 n=len(tok.encode(text,parse_special=True));cap=body['max_tokens']
 return {'input_tokens':n,'output_cap':cap,'planning_tokens':n+cap+256,'margin':256,'rendered_prompt_sha256':hashlib.sha256(text.encode()).hexdigest(),'method':'Exact loaded Strata text-only frontend/template/tokenizer; no inference'}
value=json.load(sys.stdin)
print(json.dumps([count(b) for b in value] if isinstance(value,list) else count(value)))
