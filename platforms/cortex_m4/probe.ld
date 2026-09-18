/* Address-space envelope for linking only; not a target-board capacity claim. */
ENTRY(resource_probe)
MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1M
         RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
SECTIONS {
 .text : { KEEP(*(.text.resource_probe)) *(.text*) *(.rodata*) } > FLASH
 .ARM.extab : { *(.ARM.extab*) } > FLASH
 .ARM.exidx : { *(.ARM.exidx*) } > FLASH
 .data : { *(.data*) } > RAM AT> FLASH
 .bss (NOLOAD) : { *(.bss*) *(COMMON) } > RAM
 _end = .; end = .;
 /DISCARD/ : { *(.comment) *(.note*) }
}
