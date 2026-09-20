#ifndef SC_DATA_H
#define SC_DATA_H
#include <stdint.h>
#include <stddef.h>
#define SC_DATA_MAX_GROUPS 2u
#define SC_DATA_MAX_FIELDS 5u
#define SC_DATA_MAX_VALUE 64u
#define SC_DATA_MAX_PAYLOAD 160u
/* Status values use sc_status. Schema and descriptors have static lifetime. */
typedef enum {SC_DATA_UINT64=1,SC_DATA_INT64=2,SC_DATA_BOOL=3,SC_DATA_TEXT=4,SC_DATA_BYTES=5} sc_data_type;
typedef struct {uint16_t id;uint8_t type,owner,monotonic,max_length;} sc_field_definition;
typedef struct {uint64_t u64;int64_t i64;uint8_t boolean,length;uint8_t bytes[SC_DATA_MAX_VALUE];} sc_value;
typedef int (*sc_group_validator)(const sc_value *values,size_t count);
typedef struct {uint16_t id;uint8_t count;const sc_field_definition *fields;sc_group_validator validate;} sc_group_definition;
typedef struct {uint8_t hash[32],count;const sc_group_definition *groups;} sc_data_schema;
typedef struct {
 sc_value values[SC_DATA_MAX_FIELDS],snapshot[SC_DATA_MAX_FIELDS];
 uint64_t local_revision,request_id,snapshot_id,acknowledged_id,last_sent_id;
 uint8_t request_pending,response_pending,receipt_pending,has_snapshot;
} sc_group_state;
typedef struct {sc_group_state groups[SC_DATA_MAX_GROUPS];} sc_data_state;
typedef struct {uint16_t field_id;sc_value value;} sc_data_update;
int sc_credit_validate(const sc_value *,size_t);
#include "schema/resources.h"
#endif
