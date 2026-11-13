# Embedded data attribution

Moonshine v0.1.6 compiles short VCTK reference clips into its unified runtime's ZipVoice module, including when an application only calls speech recognition. CSTR VCTK Corpus version 0.92 is by Christophe Veaux, Junichi Yamagishi and Kirsten MacDonald, University of Edinburgh, Centre for Speech Technology Research. Licensed under Creative Commons Attribution 4.0 International. Source: https://doi.org/10.7488/ds/2645 . Upstream Moonshine selects and converts excerpts to four-second, 24 kHz mono PCM clips with transcripts; Pace makes no further changes to them.

Moonshine's cpp-annote module includes parameters derived from pyannote.ai's community-1 diarization models, under Creative Commons Attribution 4.0 International. Source: https://huggingface.co/pyannote/speaker-diarization-community-1 . See the upstream cpp-annote README in sources.json for provenance. These optional diarization functions are not used by the dictation integration.

The complete CC BY 4.0 terms are in CC-BY-4.0.txt, reproduced from SPDX's license-text repository. The canonical license is https://creativecommons.org/licenses/by/4.0/legalcode . These acknowledgments do not imply endorsement by the authors.
