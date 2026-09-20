/** @file
 * @brief Typed resource schemas and public value snapshots.
 */
#ifndef SC_DATA_H
#define SC_DATA_H
#include <stdint.h>
#include <stddef.h>
/** Maximum resource groups per schema. */
#define SC_DATA_MAX_GROUPS 2u
/** Maximum fields per group. */
#define SC_DATA_MAX_FIELDS 5u
/** Maximum text/byte value length in bytes. */
#define SC_DATA_MAX_VALUE 64u
/** Maximum encoded group payload length in bytes. */
#define SC_DATA_MAX_PAYLOAD 160u
/** @ingroup resources
 * @brief Value encoding tags used by typed resource fields. */
typedef enum {
    SC_DATA_UINT64 = 1, /**< Unsigned 64-bit integer. */
    SC_DATA_INT64 = 2,  /**< Signed 64-bit integer. */
    SC_DATA_BOOL = 3,   /**< Boolean zero or one. */
    SC_DATA_TEXT = 4,   /**< Bounded UTF-8 text without embedded NUL. */
    SC_DATA_BYTES = 5   /**< Bounded arbitrary bytes. */
} sc_data_type;
/** @ingroup resources
 * @brief Immutable field descriptor with role ownership and validation constraints. */
typedef struct {
    /** Nonzero schema identifier, unique within its containing schema or group. */
    uint16_t id;
    /** One of the sc_data_type tags. */
    uint8_t type;
    /** Role allowed to update this field: SC_DEVICE or SC_SERVER. */
    uint8_t owner;
    /** Nonzero enforces nondecreasing SC_DATA_UINT64 values; invalid for other types. */
    uint8_t monotonic;
    /** Maximum text/byte length, at most SC_DATA_MAX_VALUE; unused for scalar fields. */
    uint8_t max_length;
} sc_field_definition;
/** @ingroup resources
 * @brief Bounded typed value. Only the member selected by the field type is meaningful; not a C
 * union. */
typedef struct {
    /** Unsigned 64-bit value for SC_DATA_UINT64. */
    uint64_t u64;
    /** Signed 64-bit value for SC_DATA_INT64. */
    int64_t i64;
    /** Boolean value, exactly zero or one. */
    uint8_t boolean;
    /** Text or byte value length, excluding any terminator. */
    uint8_t length;
    /** Text UTF-8 bytes or arbitrary bytes; text contains no embedded NUL and is not NUL
     * terminated. */
    uint8_t bytes[SC_DATA_MAX_VALUE];
} sc_value;
/** @ingroup resources
 * @brief Validate a complete candidate group before committing it.
 * @param values Non-null borrowed array in schema field order.
 * @param count Number of values in the candidate group.
 * @return SC_OK to accept, or a negative sc_status to reject atomically.
 */
typedef int (*sc_group_validator)(const sc_value *values, size_t count);
/** @ingroup resources
 * @brief Immutable atomic resource-group descriptor. Must outlive all contexts using it. */
typedef struct {
    /** Nonzero schema identifier, unique within its containing schema or group. */
    uint16_t id;
    /** Number of populated entries in the referenced descriptor array. */
    uint8_t count;
    /** Borrowed array of count immutable field descriptors. */
    const sc_field_definition *fields;
    /** Optional whole-group validator; NULL means only field validation is applied. */
    sc_group_validator validate;
} sc_group_definition;
/** @ingroup resources
 * @brief Immutable schema and binding hash. Must outlive all contexts using it. */
typedef struct {
    /** 32-byte schema binding hash, agreed by both endpoints. */
    uint8_t hash[32];
    /** Number of populated entries in the referenced descriptor array. */
    uint8_t count;
    /** Groups in schema order; only the configured count is used. */
    const sc_group_definition *groups;
} sc_data_schema;
/** @ingroup resources
 * @brief Copied resource values and synchronization counters for one group. */
typedef struct {
    /** Current field values in schema order. */
    sc_value values[SC_DATA_MAX_FIELDS];
    /** Frozen field values associated with snapshot_id. */
    sc_value snapshot[SC_DATA_MAX_FIELDS];
    /** Monotonic local value revision; never wraps. */
    uint64_t local_revision;
    /** Latest resource request identifier. */
    uint64_t request_id;
    /** Request identifier associated with the frozen snapshot. */
    uint64_t snapshot_id;
    /** Latest acknowledged snapshot identifier. */
    uint64_t acknowledged_id;
    /** Latest sent request or snapshot identifier. */
    uint64_t last_sent_id;
    /** Nonzero when a server request needs transmission. */
    uint8_t request_pending;
    /** Nonzero when a device response needs transmission. */
    uint8_t response_pending;
    /** Nonzero when a receipt needs transmission. */
    uint8_t receipt_pending;
    /** Nonzero when the frozen snapshot is populated. */
    uint8_t has_snapshot;
} sc_group_state;
/** @ingroup resources
 * @brief Bounded state for groups in schema order. */
typedef struct {
    /** Groups in schema order; only the configured count is used. */
    sc_group_state groups[SC_DATA_MAX_GROUPS];
} sc_data_state;
/** @ingroup resources
 * @brief One field replacement in an atomic group update. */
typedef struct {
    /** ID of the field being replaced. */
    uint16_t field_id;
    /** Replacement typed value selected by the field descriptor. */
    sc_value value;
} sc_data_update;
/**
 * @brief Validate the two-field credits invariant.
 * @ingroup credits
 * @details Requires two values in issued/consumed schema order. Returns SC_OK when consumed does
 * not exceed issued, otherwise SC_ERR_CONFLICT. Called by the generated credits schema validator.
 * @param v Non-null array of credit values in schema field order.
 * @param count Number of array elements.
 * @return SC_OK for valid credits, otherwise SC_ERR_CONFLICT.
 */
int sc_credit_validate(const sc_value *v, size_t count);
#include "schema/resources.h"
#endif
