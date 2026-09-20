/* Demo-only libsodium configuration; host builds are unaffected. */
#define CONFIGURED 1
#define MINIMAL 1
#define SODIUM_STATIC 1
#define NATIVE_LITTLE_ENDIAN 1
#define HAVE_C_VARARRAYS 1
#define RANDOMBYTES_CUSTOM_IMPLEMENTATION 1
#include "sodium/randombytes.h"
extern randombytes_implementation qtpy_random;
#define RANDOMBYTES_DEFAULT_IMPLEMENTATION (&qtpy_random)
