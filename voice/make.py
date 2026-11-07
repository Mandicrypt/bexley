# Text to speech with Kokoro-82M (Apache-2.0). Usage: python make.py lines.json voice1,voice2 outdir
import json, sys, os
import numpy as np, soundfile as sf
from kokoro import KPipeline
lines = json.load(open(sys.argv[1])); voices = sys.argv[2].split(','); out = sys.argv[3]
os.makedirs(out, exist_ok=True)
for v in voices:
    pipe = KPipeline(lang_code=v[0])
    for key, text in lines.items():
        audio = [a for _, _, a in pipe(text, voice=v, speed=float(os.environ.get('SPEED', '1.0')))]
        sf.write(f"{out}/{key}-{v}.wav", np.concatenate(audio), 24000)
        print('wrote', key, v)
