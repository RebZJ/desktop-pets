---
license: apache-2.0
---
# Kitten TTS Micro 0.8 😻

Kitten TTS is an open-source realistic text-to-speech model with 40 million parameters and around 40MB of filesize. 

## 🚀 Quick Start

### Installation

```
pip install https://github.com/KittenML/KittenTTS/releases/download/0.8/kittentts-0.8.0-py3-none-any.whl
```



### Basic Usage 

```
from kittentts import KittenTTS
m = KittenTTS("KittenML/kitten-tts-micro-0.8")
audio = m.generate("This high quality TTS model works without a GPU", voice='Jasper' )
# available_voices : ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo']
# Save the audio
import soundfile as sf
sf.write('output.wav', audio, 24000)
```

### Acknowledgements

StyleTTS 2 architecture 