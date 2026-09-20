/* Credit application policy; included by the core translation unit.
 * All mutations still pass through the generic atomic resource validator. */
int sc_credit_validate(const sc_value *v,size_t count){return count==2&&v[1].u64<=v[0].u64?SC_OK:SC_ERR_CONFLICT;}
sc_status sc_set_credits_issued(sc_context *c,uint64_t total){sc_data_update u;memset(&u,0,sizeof u);u.field_id=SC_CREDITS_ISSUED;u.value.u64=total;if(!c||!c->initialized||memcmp(data_schema(c)->hash,sc_credits_schema.hash,32))return SC_ERR_ARGUMENT;return sc_data_update_group(c,SC_CREDITS_GROUP,&u,1);}
sc_status sc_consume_credits(sc_context *c,uint64_t amount){sc_data_update u;sc_group_state g;sc_status status;if(!c||!c->initialized||!amount||memcmp(data_schema(c)->hash,sc_credits_schema.hash,32))return SC_ERR_ARGUMENT;
 if(c->config.role!=SC_DEVICE)return SC_ERR_ROLE;
 status=sc_data_inspect(c,SC_CREDITS_GROUP,&g);if(status!=SC_OK)return status;if(amount>UINT64_MAX-g.values[1].u64)return SC_ERR_EXHAUSTED;memset(&u,0,sizeof u);u.field_id=SC_CREDITS_CONSUMED;u.value.u64=g.values[1].u64+amount;return sc_data_update_group(c,SC_CREDITS_GROUP,&u,1);}
sc_status sc_request_credit_status(sc_context *c){if(!c||!c->initialized||memcmp(data_schema(c)->hash,sc_credits_schema.hash,32))return SC_ERR_ARGUMENT;return sc_data_request(c,SC_CREDITS_GROUP);}
