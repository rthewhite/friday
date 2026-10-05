"""decimating: a microphone that turns a 48 kHz microphone into a 16 kHz one (low-pass FIR, keep one frame in three).

ESPHome 2026.9 has no resampling microphone, and friday_client and micro_wake_word need 16 kHz. The reSpeaker
XVF3800 only offers 48 kHz to an ESP32 that cannot drive its MCLK. See microphone.py.
"""
