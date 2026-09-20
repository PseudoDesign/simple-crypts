/* Adapted from Pico SDK 2.3.1 linker scripts, BSD-3-Clause. See LICENSE.pico-sdk. */
RAM_ORIGIN_DEFAULT = 0x20000000;
RAM_LENGTH_DEFAULT = 224k;
MEMORY { APP_STACK(rwx) : ORIGIN = 0x20038000, LENGTH = 32k }
SCRATCH_X_ORIGIN_DEFAULT = 0x20040000;
SCRATCH_X_LENGTH_DEFAULT = 4k;
SCRATCH_Y_ORIGIN_DEFAULT = 0x20041000;
SCRATCH_Y_LENGTH_DEFAULT = 4k;
XIP_RAM_ORIGIN_DEFAULT = 0x15000000;
XIP_RAM_LENGTH_DEFAULT = 16k;
/* Include platform memory locations */
/* Set memory locations either to the already defined value, or to the default value from default_locations.ld */

/* This is the correct way to do this on newer GCC works on all supported llvm */
PROVIDE( RAM_ORIGIN = RAM_ORIGIN_DEFAULT);
PROVIDE( RAM_LENGTH = RAM_LENGTH_DEFAULT);
PROVIDE( SCRATCH_X_ORIGIN = SCRATCH_X_ORIGIN_DEFAULT);
PROVIDE( SCRATCH_X_LENGTH = SCRATCH_X_LENGTH_DEFAULT);
PROVIDE( SCRATCH_Y_ORIGIN = SCRATCH_Y_ORIGIN_DEFAULT);
PROVIDE( SCRATCH_Y_LENGTH = SCRATCH_Y_LENGTH_DEFAULT);
PROVIDE( XIP_RAM_ORIGIN = XIP_RAM_ORIGIN_DEFAULT);
PROVIDE( XIP_RAM_LENGTH = XIP_RAM_LENGTH_DEFAULT);

/*
 * This works on GCC when the above doesn't, but doesn't work on older llvm if the value being checked
 * is not already defined (it assigns 0 because the LHS creates the var), but fortunately the PROVIDE above
 * fixes the issue for older llvm - net result is that with both the above and the below, we get
 * the right answer on all supported linkers!
 */
RAM_ORIGIN = DEFINED(RAM_ORIGIN) ? RAM_ORIGIN : RAM_ORIGIN_DEFAULT;
RAM_LENGTH = DEFINED(RAM_LENGTH) ? RAM_LENGTH : RAM_LENGTH_DEFAULT;
SCRATCH_X_ORIGIN = DEFINED(SCRATCH_X_ORIGIN) ? SCRATCH_X_ORIGIN : SCRATCH_X_ORIGIN_DEFAULT;
SCRATCH_X_LENGTH = DEFINED(SCRATCH_X_LENGTH) ? SCRATCH_X_LENGTH : SCRATCH_X_LENGTH_DEFAULT;
SCRATCH_Y_ORIGIN = DEFINED(SCRATCH_Y_ORIGIN) ? SCRATCH_Y_ORIGIN : SCRATCH_Y_ORIGIN_DEFAULT;
SCRATCH_Y_LENGTH = DEFINED(SCRATCH_Y_LENGTH) ? SCRATCH_Y_LENGTH : SCRATCH_Y_LENGTH_DEFAULT;
XIP_RAM_ORIGIN = DEFINED(XIP_RAM_ORIGIN) ? XIP_RAM_ORIGIN : XIP_RAM_ORIGIN_DEFAULT;
XIP_RAM_LENGTH = DEFINED(XIP_RAM_LENGTH) ? XIP_RAM_LENGTH : XIP_RAM_LENGTH_DEFAULT;


/* Include memory regions used */
MEMORY
{
    FLASH(rx) : ORIGIN = 0x10000000, LENGTH = 0x7df000

}

/* RP2040 has no PSRAM support */

MEMORY
{
    XIP_RAM(rwx) : ORIGIN = XIP_RAM_ORIGIN, LENGTH = XIP_RAM_LENGTH
}

MEMORY
{
    RAM(rwx) : ORIGIN =  RAM_ORIGIN, LENGTH = RAM_LENGTH
}

MEMORY
{
    SCRATCH_X(rwx) : ORIGIN = SCRATCH_X_ORIGIN, LENGTH = SCRATCH_X_LENGTH
    SCRATCH_Y(rwx) : ORIGIN = SCRATCH_Y_ORIGIN, LENGTH = SCRATCH_Y_LENGTH
}

/* DO NOT OVERRIDE THIS FILE

   This file is provided for the SDK to override
*/

/* Empty file

   This file can be overridden to add extra memory regions.

   For example, to add an extra flash region for the second 4MiB
   of flash, you could replace this file with:

   MEMORY
   {
      EXTRA_FLASH(rx) : ORIGIN = 0x10400000, LENGTH = 4M
   }

   Or to include the FLASH region in a no_flash build, you could
   replace this file with:

   MEMORY
{
    FLASH(rx) : ORIGIN = 0x10000000, LENGTH = 0x7df000

}

*/


/* Include aliases for storage memory regions */
/* Store everything in flash */

REGION_ALIAS("TEXT_STORE", FLASH);
REGION_ALIAS("RAM_STORE", FLASH);
REGION_ALIAS("PSRAM_STORE", FLASH);
REGION_ALIAS("XIP_RAM_STORE", FLASH);
REGION_ALIAS("SCRATCH_X_STORE", FLASH);
REGION_ALIAS("SCRATCH_Y_STORE", FLASH);


/* Define entry point symbol */
ENTRY(_entry_point)

/* Include default sections */
/* Main section list for default binaries */

/* This swaps section_boot2 and section_default_text, because RP2040 binaries must begin with boot2 */

/* Defines the following symbols for use by code:
    __flash_binary_start
*/

SECTIONS
{
    .flash_begin : {
        __flash_binary_start = .;
    } > TEXT_STORE
}

SECTIONS
{
    /* Second stage bootloader is prepended to the image. It must be 256 bytes big
       and checksummed. It is usually built by the boot_stage2 target
       in the Raspberry Pi Pico SDK
    */

    .boot2 : {
        __boot2_start__ = .;
        KEEP (*(.boot2))
        __boot2_end__ = .;
    } > TEXT_STORE

    ASSERT(__boot2_end__ - __boot2_start__ == 256,
        "ERROR: Pico second stage bootloader must be exactly 256 bytes in size for RP2040")
}

/* Defines the following symbols for use by code:
    __logical_binary_start
    __binary_info_header_end
    __embedded_block_end
    __preinit_array_start, __preinit_array_end
    __init_array_start, __init_array_end
    __bothinit_array_start, __bothinit_array_end
    __fini_array_start, __fini_array_end
    __dso_handle
*/

SECTIONS
{
    /* The bootrom will enter the image at the entry point indicated in your
       IMAGE_DEF, which is usually the reset handler of your vector table.
       If there is no entry point indicated in the IMAGE_DEF, it expects a VT
       at the start of the image, and will use the entry point from that.

       The debugger will use the ELF entry point, which is the _entry_point
       symbol, and in our case is *different from the bootrom's entry point.*
       This is used to go back through the bootrom on debugger launches only,
       to perform the same initial flash setup that would be performed on a
       cold boot.
    */

    .text : {
        __logical_binary_start = .;
        KEEP (*(.vectors))
        KEEP (*(.binary_info_header))
        __binary_info_header_end = .;
        KEEP (*(.embedded_block))
        __embedded_block_end = .;
        KEEP (*(.reset))
        /* bit of a hack right now to exclude all floating point code from FLASH
         * ... we will include any thing excluded here in .data below by default */
        *(.init)
        *libgcc.a:cmse_nonsecure_call.o
        *(EXCLUDE_FILE(*libgcc.a: *libm.a:) .text*)
        *(.fini)
        /* Pull all c'tors into .text */
        *crtbegin.o(.ctors)
        *crtbegin?.o(.ctors)
        *(EXCLUDE_FILE(*crtend?.o *crtend.o) .ctors)
        *(SORT(.ctors.*))
        *(.ctors)
        /* Followed by destructors */
        *crtbegin.o(.dtors)
        *crtbegin?.o(.dtors)
        *(EXCLUDE_FILE(*crtend?.o *crtend.o) .dtors)
        *(SORT(.dtors.*))
        *(.dtors)

        . = ALIGN(4);
        /* preinit data */
        PROVIDE_HIDDEN (__bothinit_array_start = .);
        PROVIDE_HIDDEN (__preinit_array_start = .);
        KEEP(*(SORT(.preinit_array.*)))
        KEEP(*(.preinit_array))
        PROVIDE_HIDDEN (__preinit_array_end = .);

        . = ALIGN(4);
        /* init data */
        PROVIDE_HIDDEN (__init_array_start = .);
        KEEP(*(SORT(.init_array.*)))
        KEEP(*(.init_array))
        PROVIDE_HIDDEN (__init_array_end = .);
        PROVIDE_HIDDEN (__bothinit_array_end = .);

        . = ALIGN(4);
        /* finit data */
        PROVIDE_HIDDEN (__fini_array_start = .);
        *(SORT(.fini_array.*))
        *(.fini_array)
        PROVIDE_HIDDEN (__fini_array_end = .);
        PROVIDE(__dso_handle = 0);

        *(.eh_frame*)
        . = ALIGN(4);
    } > TEXT_STORE
}

SECTIONS
{
    .rodata : {
        *(EXCLUDE_FILE(*libgcc.a: *libm.a:) .rodata*)
        *(.srodata*)
        . = ALIGN(4);
        *(SORT_BY_ALIGNMENT(SORT_BY_NAME(.flashdata*)))
        . = ALIGN(4);
    } > TEXT_STORE
}

/* Defines the following symbols for use by code:
    __exidx_start, __exidx_end
*/

SECTIONS
{
    .ARM.extab :
    {
        *(.ARM.extab* .gnu.linkonce.armextab.*)
    } > TEXT_STORE

    __exidx_start = .;
    .ARM.exidx :
    {
        *(.ARM.exidx* .gnu.linkonce.armexidx.*)
    } > TEXT_STORE
    __exidx_end = .;
}

/* Defines the following symbols for use by code:
    __binary_info_start, __binary_info_end
*/

SECTIONS
{
    /* Machine inspectable binary information */
    . = ALIGN(4);
    __binary_info_start = .;
    .binary_info :
    {
        KEEP(*(.binary_info.keep.*))
        *(.binary_info.*)
    } > TEXT_STORE
    __binary_info_end = .;
    . = ALIGN(4);
}


/* DO NOT OVERRIDE THIS FILE

   This file is provided for the SDK to override
*/

/* Empty file

   This file is included between the end of text and the start of data.

   It can be overridden to add extra sections into flash.
*/

/* RP2040 has no PSRAM support */

/* Defines the following symbols for use by code:
    __xip_ram_start__, __xip_ram_end__, __xip_ram_source__
*/

SECTIONS
{
    .xip_ram : {
        __xip_ram_start__ = .;
        . = ALIGN(4);
        *(.xip_ram*)
        . = ALIGN(4);
        __xip_ram_end__ = .;
    } > XIP_RAM AT> XIP_RAM_STORE
    __xip_ram_source__ = LOADADDR(.xip_ram);
}

/* Sub-section list for read/write sections in default binaries */

SECTIONS
{
    .ram_vector_table (NOLOAD): {
        *(.ram_vector_table)
    } > RAM
}

SECTIONS
{
    .uninitialized_data (NOLOAD): {
        . = ALIGN(4);
        *(.uninitialized_data*)
    } > RAM
}

/* Defines the following symbols for use by code:
    __data_start__, __data_end__
    __mutex_array_start, __mutex_array_end
    __etext
    __bss_start__, __bss_end__
    __tls_base, __tls_end
    __tbss_end
    __global_pointer$
*/

SECTIONS
{
    .data : {
        __data_start__ = .;
        *(vtable)

        *(.time_critical*)

        /* remaining .text and .rodata; i.e. stuff we exclude in ..._excludes files because we want it in RAM */
        *(.text*)
        . = ALIGN(4);
        *(.rodata*)
        . = ALIGN(4);

        PROVIDE_HIDDEN (__emutls_array_start = .);
        *(.*.__emutls_v.*)
        PROVIDE_HIDDEN (__emutls_array_end = .);
        . = ALIGN(4);

        *(.data*)
        *(.sdata*)

	    /* Linking against non PIC archives, or using TLS without -ftls-model=local-exec (which we shouldn't),
	       generate dynamic data relocations via got sections, so include them explicitly to avoid surprises.
	       Ideally these are always 0 sized */
        *(.got)
        *(.got.*)

        . = ALIGN(4);
        *(.after_data.*)
        . = ALIGN(4);
        /* preinit data */
        PROVIDE_HIDDEN (__mutex_array_start = .);
        KEEP(*(SORT(.mutex_array.*)))
        KEEP(*(.mutex_array))
        PROVIDE_HIDDEN (__mutex_array_end = .);

        *(.jcr)
        . = ALIGN(4);
    } > RAM AT> RAM_STORE

    .tdata : {
        . = ALIGN(4);
		*(.tdata .tdata.* .gnu.linkonce.td.*)
        /* All data end */
        __tdata_end = .;
    } > RAM AT> RAM_STORE
    PROVIDE(__data_end__ = .);

    /* __etext is (for backwards compatibility) the name of the .data init source pointer (...) */
    __etext = LOADADDR(.data);

    . = ALIGN(4);
    /* note that .tbss is expected to directly follow .tdata */
    .tbss (NOLOAD) : {
        __bss_start__ = .;
        __tls_base = .;
        *(.tbss .tbss.* .gnu.linkonce.tb.*)
        *(.tcommon)

        . = ALIGN(4);
        __tls_end = .;
    } > RAM

    /* workaround RISC-V GNU linker bug with spacer section (otherwise it places .bss over .tbss) */
    .tbss_space (NOLOAD) : {
        . = __bss_start__ + SIZEOF(.tbss);
    } > RAM

    .bss (NOLOAD) : {
        . = ALIGN(4);
        __tbss_end = .;

        *(SORT_BY_ALIGNMENT(SORT_BY_NAME(.bss*)))
        *(COMMON)
        PROVIDE(__global_pointer$ = . + 2K);
        *(.sbss*)
        . = ALIGN(4);
        __bss_end__ = .;
    } > RAM

}

/* Sections for proper TLS

    Defines the following symbols for use by code:
    __tls_start, __tls_size, __tls_align, __tls_size_align
    __arm32_tls_tcb_offset
    __tdata_size, __tdata_source, __tbss_size, __tbs_offset
*/

SECTIONS
{
    PROVIDE( __tls_start = SIZEOF(.tdata) ? ADDR(.tdata) : ADDR(.tbss) );
    PROVIDE( __tls_size = __tls_end - __tls_start );
    PROVIDE( __tls_align = MAX(ALIGNOF(.tdata), ALIGNOF(.tbss)) );
    PROVIDE( __tls_size_align = ALIGN( __tls_size, __tls_align) );
    PROVIDE( __arm32_tls_tcb_offset = MAX(8, __tls_align) );
    PROVIDE( __tdata_size = SIZEOF(.tdata) );
    PROVIDE( __tdata_source = LOADADDR(.tdata) );
    PROVIDE( __tbss_size = SIZEOF(.tbss) );
    PROVIDE( __tbss_offset = ADDR(.tbss) - __tls_start );

    /* this marker is present if the code knows we don't need __tls0 and __tls1... we decide
     * to waste 4 bytes in that case rather than possibly large amounts for __tls0 and __tls1
     * which will never be used */
    .tlsX_not_needed_marker (NOLOAD) : {
        KEEP(*(.tlsX_not_needed_marker))
    } > RAM
    PROVIDE( __tlsX_align = SIZEOF(.tlsX_not_needed_marker) > 0 ? 4 : __tls_align);
    PROVIDE( __tlsX_size_align = SIZEOF(.tlsX_not_needed_marker) > 0 ? 0 : __tls_size_align);

    /*
     * Workaround older toolchain bugs by doing the PROVIDE(x = y) followed by x = DEFINED(x) ? x : y
     *
     * Note there is probably a less verbose fix in this case as many of these symbols are
     * potentially not needed on older GCC for instance which is certainly using emutls
     * but this fix style is known to be correct, so is likely clearer
     */
    __tls_start = DEFINED( __tls_start) ?  __tls_start : SIZEOF(.tdata) ? ADDR(.tdata) : ADDR(.tbss);
    __tls_size = DEFINED( __tls_size) ?  __tls_size : __tls_end - __tls_start;
    __tls_align = DEFINED( __tls_align) ?  __tls_align : MAX(ALIGNOF(.tdata), ALIGNOF(.tbss));
    __tls_size_align = DEFINED( __tls_size_align) ?  __tls_size_align : ALIGN( __tls_size, __tls_align);
    __arm32_tls_tcb_offset = DEFINED( __arm32_tls_tcb_offset) ?  __arm32_tls_tcb_offset : MAX(8, __tls_align);
    __tdata_size = DEFINED( __tdata_size) ?  __tdata_size : SIZEOF(.tdata);
    __tdata_source = DEFINED( __tdata_source) ?  __tdata_source : LOADADDR(.tdata);
    __tbss_size = DEFINED( __tbss_size) ?  __tbss_size : SIZEOF(.tbss);
    __tbss_offset = DEFINED( __tbss_offset) ?  __tbss_offset : ADDR(.tbss) - __tls_start;

    __tlsX_align      = DEFINED(__tlsX_align)      ? __tlsX_align      : (SIZEOF(.tlsX_not_needed_marker) > 0 ? 4 : __tls_align);
    __tlsX_size_align = DEFINED(__tlsX_size_align) ? __tlsX_size_align : (SIZEOF(.tlsX_not_needed_marker) > 0 ? 0 : __tls_size_align);

    /* Thread local storage static allocations, one per core */
    .tls0 (NOLOAD) : {
       . = ALIGN(__tlsX_align);
       PROVIDE(__tls0_base = .);
       . = . + __tlsX_size_align;
    } > RAM

    .tls1 (NOLOAD) : {
        . = ALIGN(__tlsX_align);
        PROVIDE(__tls1_base = .);
        . = . + __tlsX_size_align;
    } > RAM

}

/* Defines the following symbols for use by code:
    __persistent_data_start__, __persistent_data_end__
*/

SECTIONS
{
    .persistent_data (NOLOAD) : {
        __persistent_data_start__ = .;
        *(.persistent_data*)
        . = ALIGN(4);
    } > RAM
    PROVIDE(__persistent_data_end__ = .);
}

/* DO NOT OVERRIDE THIS FILE

   This file is provided for the SDK to override
*/

/* Empty file

   This file is included between the end of data/bss and the start of the heap.

   It can be overridden to add extra sections into ram.
*/

/* Defines the following symbols for use by code:
    __HeapLimit
*/

SECTIONS
{
    .dummy_pre_heap (NOLOAD):
    {
        /* Dummy section to make sure we're back in normal RAM for the heap when HEAP_LOC isn't defined */
        . = .;
    } > RAM
    .heap DEFINED(HEAP_LOC) ? HEAP_LOC : . (NOLOAD):
    {
        __end__ = .;
        end = __end__;
        KEEP(*(.heap*))
    } > RAM
    /* historically on GCC sbrk was growing past __HeapLimit to __StackLimit, however
       to be more compatible, we now set __HeapLimit explicitly to where the end of the heap is */
    __HeapLimit = DEFINED(HEAP_LIMIT) ? HEAP_LIMIT : ORIGIN(RAM) + LENGTH(RAM);
}

/* Defines the following symbols for use by code:
    __scratch_x_start__, __scratch_x_end__, __scratch_x_source__
    __scratch_y_start__, __scratch_y_end__, __scratch_y_source__
*/

SECTIONS
{
    /* Start and end symbols must be word-aligned */
    .scratch_x : {
        __scratch_x_start__ = .;
        *(.scratch_x.*)
        . = ALIGN(4);
        __scratch_x_end__ = .;
    } > SCRATCH_X AT> SCRATCH_X_STORE
    __scratch_x_source__ = LOADADDR(.scratch_x);

    .scratch_y : {
        __scratch_y_start__ = .;
        *(.scratch_y.*)
        . = ALIGN(4);
        __scratch_y_end__ = .;
    } > SCRATCH_Y AT> SCRATCH_Y_STORE
    __scratch_y_source__ = LOADADDR(.scratch_y);
}

/* DO NOT OVERRIDE THIS FILE

   This file is provided for the SDK to override
*/

/* Empty file

   This file is included between the end of scratch and the start of the stack.

   It can be overridden to add extra sections in the scratch memory, before the stack.
*/

SECTIONS
{
    /* .stack*_dummy section doesn't contains any symbols. It is only
     * used for linker to calculate size of stack sections, and assign
     * values to stack symbols later
     *
     * stack1 section may be empty/missing if platform_launch_core1 is not used */

    /* by default we put core 0 stack at the end of scratch Y, so that if core 1
     * stack is not used then all of SCRATCH_X is free.
     */
    .stack1_dummy (NOLOAD):
    {
        *(.stack1*)
    } > SCRATCH_X
    .stack_dummy (NOLOAD):
    {
        KEEP(*(.stack*))
    } > APP_STACK
}

/* Defines the following symbols for use by code:
    __flash_binary_end
*/

SECTIONS
{
    .flash_end : {
        KEEP(*(.embedded_end_block*))
        PROVIDE(__flash_binary_end = .);
    } > TEXT_STORE =0xaa
}

/* Defines the following symbols for use by code:
    __StackLimit
    __StackOneTop, __StackOneBottom
    __StackTop, __StackBottom
    __stack (== __StackTop)

    Also defines additional symbols for other compilers/libcs
*/

SECTIONS
{
    /* stack limit is poorly named, but historically is maximum heap ptr */
    __StackLimit = ORIGIN(RAM) + LENGTH(RAM);
    __StackOneTop = ORIGIN(SCRATCH_X) + LENGTH(SCRATCH_X);
    __StackTop = ORIGIN(APP_STACK) + LENGTH(APP_STACK);
    __StackOneBottom = __StackOneTop - SIZEOF(.stack1_dummy);
    __StackBottom = __StackTop - SIZEOF(.stack_dummy);
    PROVIDE(__stack = __StackTop);

    /* picolibc and LLVM */
    PROVIDE (__heap_start = __end__);
    PROVIDE (__heap_end = __HeapLimit);
    PROVIDE( __tls_align = MAX(ALIGNOF(.tdata), ALIGNOF(.tbss)) );
    PROVIDE( __tls_size_align = (__tls_size + __tls_align - 1) & ~(__tls_align - 1));
    PROVIDE( __arm32_tls_tcb_offset = MAX(8, __tls_align) );

    /* llvm-libc */
    PROVIDE (_end = __end__);
    PROVIDE (__llvm_libc_heap_limit = __HeapLimit);

    /* Check if data + heap + stack exceeds RAM limit */
    ASSERT(__StackLimit >= __HeapLimit, "region RAM overflowed")
}

/* DO NOT OVERRIDE THIS FILE

   This file is provided for the SDK to override
*/

/* Empty file

   This file is included after the section_end file.

   It can be overridden to override any symbols provided by the linker scripts,
   or to add custom asserts.
*/

SECTIONS
{
    ASSERT( __binary_info_header_end - __logical_binary_start <= 256, "Binary info must be in first 256 bytes of the binary")
}

/* DO NOT OVERRIDE THIS FILE

   This file is provided for the SDK to override
*/

/* Empty file

   This file is included after the section_platform_end file.

   It can be overridden to override any symbols provided by the linker scripts,
   or to add custom asserts.

   It is intended to be used for platform specific overrides.
*/



ASSERT(SIZEOF(.boot2) == 256, "boot2 must be 256 bytes")
ASSERT(__flash_binary_end <= 0x107df000, "firmware overlaps demo NVM")
ASSERT(__StackBottom >= 0x20038000, "stack overflow")
