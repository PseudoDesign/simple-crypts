/* Bounded resource engine. Included here to share the atomic record transaction. */
static const sc_data_schema *data_schema(const sc_context *c){return c->config.data_schema?c->config.data_schema:&sc_credits_schema;}
static int group_index(const sc_context *c,uint16_t id){const sc_data_schema *s=data_schema(c);unsigned i;for(i=0;i<s->count;i++)if(s->groups[i].id==id)return (int)i;return -1;}
static int value_equal(const sc_field_definition *f,const sc_value *a,const sc_value *b){
 switch(f->type){case SC_DATA_UINT64:return a->u64==b->u64;case SC_DATA_INT64:return a->i64==b->i64;case SC_DATA_BOOL:return a->boolean==b->boolean;default:return a->length==b->length&&!memcmp(a->bytes,b->bytes,a->length);}
}
static sc_status values_valid(const sc_group_definition *d,const sc_value *v){unsigned i;for(i=0;i<d->count;i++){
 const sc_field_definition *f=&d->fields[i];
 if(f->type==SC_DATA_BOOL&&v[i].boolean>1)return SC_ERR_ARGUMENT;
 if(f->type>=SC_DATA_TEXT){if(v[i].length>f->max_length)return SC_ERR_BOUNDS;if(f->type==SC_DATA_TEXT&&!valid_utf8(v[i].bytes,v[i].length))return SC_ERR_UTF8;}
 }return d->validate?(sc_status)d->validate(v,d->count):SC_OK;
}
static size_t values_encode(const sc_group_definition *d,const sc_value *v,uint8_t *out){unsigned i,j;size_t n=0;for(i=0;i<d->count;i++){
 const sc_field_definition *f=&d->fields[i];size_t len=f->type>=4?v[i].length:f->type==3?1:8;
 out[n++]=(uint8_t)(f->id>>8);out[n++]=(uint8_t)f->id;out[n++]=f->type;out[n++]=(uint8_t)len;
 if(f->type>=4)memcpy(out+n,v[i].bytes,len);else if(f->type==3)out[n]=v[i].boolean;else{uint64_t x=f->type==1?v[i].u64:(uint64_t)v[i].i64;for(j=0;j<8;j++)out[n+7-j]=(uint8_t)(x>>(8*j));}n+=len;
 }return n;
}
static sc_status values_decode(const sc_group_definition *d,const uint8_t *in,size_t size,sc_value *v){unsigned i,j;size_t n=0;memset(v,0,SC_DATA_MAX_FIELDS*sizeof *v);for(i=0;i<d->count;i++){
 const sc_field_definition *f=&d->fields[i];size_t len;
 if(size-n<4||in[n]!=(uint8_t)(f->id>>8)||in[n+1]!=(uint8_t)f->id||in[n+2]!=f->type)return SC_ERR_PROTOCOL;
 len=in[n+3];n+=4;if(size-n<len)return SC_ERR_PROTOCOL;
 if(f->type>=4){if(len>f->max_length)return SC_ERR_BOUNDS;v[i].length=(uint8_t)len;memcpy(v[i].bytes,in+n,len);}
 else if(f->type==3){if(len!=1)return SC_ERR_PROTOCOL;v[i].boolean=in[n];}
 else{uint64_t x=0;if(len!=8)return SC_ERR_PROTOCOL;for(j=0;j<8;j++)x=(x<<8)|in[n+j];if(f->type==1)v[i].u64=x;else v[i].i64=x<=INT64_MAX?(int64_t)x:-1-(int64_t)(UINT64_MAX-x);}
 n+=len;
 }if(n!=size)return SC_ERR_PROTOCOL;return values_valid(d,v);
}
static sc_status schema_valid(const sc_data_schema *s){unsigned i,j,k;size_t n;if(!s||!s->count||s->count>SC_DATA_MAX_GROUPS||!s->groups)return SC_ERR_ARGUMENT;
 for(i=0;i<s->count;i++){const sc_group_definition *d=&s->groups[i];if(!d->id||!d->count||d->count>SC_DATA_MAX_FIELDS||!d->fields)return SC_ERR_ARGUMENT;for(k=0;k<i;k++)if(s->groups[k].id==d->id)return SC_ERR_ARGUMENT;n=0;
 for(j=0;j<d->count;j++){const sc_field_definition *f=&d->fields[j];if(!f->id||f->type<1||f->type>5||f->owner<1||f->owner>2||(f->monotonic&&f->type!=1)||f->max_length>SC_DATA_MAX_VALUE)return SC_ERR_ARGUMENT;for(k=0;k<j;k++)if(d->fields[k].id==f->id)return SC_ERR_ARGUMENT;n+=4+(f->type>=4?f->max_length:f->type==3?1:8);}
 if(n>SC_DATA_MAX_PAYLOAD)return SC_ERR_BOUNDS;
 }return SC_OK;
}
sc_status sc_data_inspect(const sc_context *c,uint16_t id,sc_group_state *out){int i;if(!c||!c->initialized||!out)return SC_ERR_ARGUMENT;i=group_index(c,id);if(i<0)return SC_NOT_FOUND;*out=c->state.data.groups[i];return SC_OK;}
sc_status sc_data_update_group(sc_context *c,uint16_t id,const sc_data_update *updates,size_t count){
 sc_state next;sc_group_state *g;const sc_group_definition *d;int i;unsigned j,k;int changed=0;sc_status status;
 if(!c||!c->initialized||!updates||!count||count>SC_DATA_MAX_FIELDS)return SC_ERR_ARGUMENT;
 if(!c->state.registered)return SC_ERR_ENROLLMENT;
 i=group_index(c,id);if(i<0)return SC_NOT_FOUND;
 next=c->state;g=&next.data.groups[i];d=&data_schema(c)->groups[i];
 for(j=0;j<count;j++){
  for(k=0;k<j;k++)if(updates[j].field_id==updates[k].field_id)return SC_ERR_ARGUMENT;
  for(k=0;k<d->count&&d->fields[k].id!=updates[j].field_id;k++){}if(k==d->count)return SC_NOT_FOUND;
  if(d->fields[k].owner!=c->config.role)return SC_ERR_ROLE;
  if(d->fields[k].monotonic&&updates[j].value.u64<g->values[k].u64)return SC_ERR_CONFLICT;
  if(!value_equal(&d->fields[k],&updates[j].value,&g->values[k]))changed=1;
  g->values[k]=updates[j].value;
 }
 status=values_valid(d,g->values);if(status!=SC_OK)return status;if(!changed)return SC_OK;
 if(g->local_revision==UINT64_MAX)return SC_ERR_EXHAUSTED;
 g->local_revision++;
 if(c->config.role==SC_SERVER){if(g->request_id==UINT64_MAX)return SC_ERR_EXHAUSTED;g->request_id++;g->request_pending=1;}
 return save(c,&next);
}
sc_status sc_data_request(sc_context *c,uint16_t id){sc_state next;sc_group_state *g;int i;
 if(!c||!c->initialized)return SC_ERR_ARGUMENT;
 if(c->config.role!=SC_SERVER)return SC_ERR_ROLE;
 if(!c->state.registered)return SC_ERR_ENROLLMENT;
 i=group_index(c,id);if(i<0)return SC_NOT_FOUND;next=c->state;g=&next.data.groups[i];if(g->request_id==UINT64_MAX)return SC_ERR_EXHAUSTED;g->request_id++;g->request_pending=1;return save(c,&next);
}
/* Compact typed updates: field ID (big endian u16), type, length, value.
 * Public bindings encode these records; validation still occurs in the core. */
sc_status sc_data_update_encoded(sc_context *c,uint16_t id,const uint8_t *bytes,size_t n){
 sc_data_update updates[SC_DATA_MAX_FIELDS];size_t at=0,count=0;int i;unsigned j;sc_status status;
 if(!c||!c->initialized||!bytes||!n)return SC_ERR_ARGUMENT;
 i=group_index(c,id);if(i<0)return SC_NOT_FOUND;
 while(at<n){const sc_group_definition *d=&data_schema(c)->groups[i];sc_group_definition one;sc_value value[SC_DATA_MAX_FIELDS];uint16_t field;size_t length;
  if(n-at<4||count==SC_DATA_MAX_FIELDS)return SC_ERR_BOUNDS;
  field=(uint16_t)((bytes[at]<<8)|bytes[at+1]);length=4u+bytes[at+3];if(length>n-at)return SC_ERR_BOUNDS;
  for(j=0;j<d->count&&d->fields[j].id!=field;j++){}if(j==d->count)return SC_NOT_FOUND;
  one.id=id;one.count=1;one.fields=&d->fields[j];one.validate=NULL;
  status=values_decode(&one,bytes+at,length,value);if(status!=SC_OK)return status;
  updates[count].field_id=field;updates[count].value=value[0];count++;at+=length;
 }
 return sc_data_update_group(c,id,updates,count);
}
sc_status sc_data_encode_values(const sc_context *c,uint16_t id,uint8_t *out,size_t cap,size_t *length){
 uint8_t bytes[SC_DATA_MAX_PAYLOAD];size_t n;int i;if(length)*length=0;
 if(!c||!c->initialized||!out||!length)return SC_ERR_ARGUMENT;
 i=group_index(c,id);if(i<0)return SC_NOT_FOUND;
 n=values_encode(&data_schema(c)->groups[i],c->state.data.groups[i].values,bytes);
 if(n>cap)return SC_ERR_BOUNDS;
 memcpy(out,bytes,n);*length=n;return SC_OK;
}
