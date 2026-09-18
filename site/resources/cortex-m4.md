# Cortex-M4 resource measurement

arm-none-eabi-gcc (15:13.2.rel1-2) 13.2.1 20231009

| Measurement | Bytes |
|---|---:|
| Linked text / rodata | 61064 |
| Initialized data | 1456 |
| Zero-initialized data | 2392 |
| Text + data (flash sections) | 62520 |
| Data + bss (static RAM) | 3848 |

Core, nanopb, the portable libsodium provider, and both authenticated encryption/decryption paths are retained in this ELF. The profile uses the same pinned libsodium 1.0.20 source and portable provider as the host.

The `endpoint`, frame, persistence-buffer, and fake-keystore symbols below belong to the measurement harness. Core context size is the `endpoint` symbol size. No total RAM or usable MCU minimum is claimed.

| Static symbol | Bytes |
|---|---:|
| `__malloc_av_` | 1032 |
| `endpoint` | 952 |
| `frame` | 512 |
| `saved` | 512 |
| `__sf` | 312 |
| `_impure_data` | 288 |
| `__malloc_current_mallinfo` | 40 |
| `private_key` | 32 |
| `public_key` | 32 |
| `crypto_onetimeauth_poly1305_donna_implementation` | 20 |
| `crypto_scalarmult_curve25519_ref10_implementation` | 8 |
| `crypto_stream_salsa20_ref_implementation` | 8 |
| `generation` | 8 |
| `keys.0` | 8 |
| `reservation` | 8 |
| `__malloc_max_sbrked_mem` | 4 |
| `__malloc_max_total_mem` | 4 |
| `__malloc_sbrk_base` | 4 |
| `__malloc_top_pad` | 4 |
| `__malloc_trim_threshold` | 4 |
| `__stdio_exit_handler` | 4 |
| `_impure_ptr` | 4 |
| `_misuse_handler` | 4 |
| `_sodium_lock` | 4 |
| `errno` | 4 |
| `heap_end.0` | 4 |
| `implementation` | 4 |
| `implementation` | 4 |
| `implementation` | 4 |
| `saved_length` | 4 |
| `observed` | 1 |

## Largest retained per-function stack frames

Compiler `.su` records show individual function frames, not a maximum call-chain sum. Precompiled libc/libgcc, interrupts, board drivers, RTOS tasks and stacks, flash journal, startup, and entropy/provider integration need separate measurement.

| Function | Frame bytes | Classification |
|---|---:|---|
| `save` | 888 | static |
| `sc_outbound` | 712 | static |
| `sc_receive` | 712 | static |
| `ge25519_scalarmult_base` | 488 | static |
| `sc_init` | 472 | static |
| `crypto_secretbox_detached` | 432 | static |
| `crypto_scalarmult_curve25519_ref10.part.0` | 392 | static |
| `sc_report_temperature` | 296 | static |
| `crypto_scalarmult_curve25519_ref10_base` | 288 | static |
| `fe25519_mul` | 184 | static |
| `fe25519_mul` | 184 | static |
| `fe25519_invert` | 176 | static |
| `crypto_onetimeauth_poly1305_donna` | 176 | static |
| `crypto_secretbox_open_detached` | 168 | static |
| `stream_ref_xor_ic` | 160 | static |
| `ge25519_cmov8` | 152 | static |
| `crypto_core_salsa20` | 144 | static |
| `stream_ref` | 144 | static |
| `pb_decode_inner` | 144 | static |
| `ge25519_p3_dbl` | 136 | static |

## Limits

- Not executed on hardware; no latency or energy claim.
- Stack frame sizes are not a call-chain, interrupt, or whole-program peak.
- Includes measurement harness state and buffers; not a board firmware budget.
- Platform callbacks are nonproduction measurement stubs; linker address space is not a board capacity.
- Generic software crypto defaults; no sodium_init/RNG/platform startup linked. Real board initialization must be validated.
