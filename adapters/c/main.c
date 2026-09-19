#define _POSIX_C_SOURCE 200809L
/* Test-only JSONL process adapter calling the public host C SDK. Fixed seeds,
 * server_seed and initial_revision are fixture inputs, never relay commands. */
#include "providers/host/sc_host.h"
#include "core/sc.h"
#include <sodium.h>
#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { char key[64], value[4096]; int string; } field;
typedef struct { field fields[32]; size_t count; } object;
static void space(const char **p) { while (isspace((unsigned char)**p)) ++*p; }
static int hex_digit(int c) {
    if(c>='0'&&c<='9')return c-'0';
    if(c>='a'&&c<='f')return c-'a'+10;
    if(c>='A'&&c<='F')return c-'A'+10;
    return -1;
}
static int codepoint(const char **p,unsigned *out) {
    int i,v;*out=0;for(i=0;i<4;++i){v=hex_digit((unsigned char)**p);if(v<0)return 0;*out=(*out<<4)|(unsigned)v;++*p;}return 1;
}
static int string(const char **p,char *out,size_t capacity) {
    size_t n=0;unsigned c,low;char bytes[4];size_t count;
    if(*(*p)++!='"')return 0;
    while(**p&&**p!='"') {
        c=(unsigned char)*(*p)++;count=1;bytes[0]=(char)c;
        if(c<32)return 0;
        if(c=='\\') {
            c=(unsigned char)*(*p)++;
            switch(c) {
            case '"':case '\\':case '/':bytes[0]=(char)c;break;
            case 'b':bytes[0]='\b';break;case 'f':bytes[0]='\f';break;case 'n':bytes[0]='\n';break;case 'r':bytes[0]='\r';break;case 't':bytes[0]='\t';break;
            case 'u':
                if(!codepoint(p,&c)||c==0)return 0;
                if(c>=0xd800&&c<=0xdbff){if((*p)[0]!='\\'||(*p)[1]!='u')return 0;*p+=2;if(!codepoint(p,&low)||low<0xdc00||low>0xdfff)return 0;c=0x10000+((c-0xd800)<<10)+(low-0xdc00);}
                else if(c>=0xdc00&&c<=0xdfff)return 0;
                if(c<0x80){bytes[0]=(char)c;}
                else if(c<0x800){count=2;bytes[0]=(char)(0xc0|(c>>6));bytes[1]=(char)(0x80|(c&63));}
                else if(c<0x10000){count=3;bytes[0]=(char)(0xe0|(c>>12));bytes[1]=(char)(0x80|((c>>6)&63));bytes[2]=(char)(0x80|(c&63));}
                else{count=4;bytes[0]=(char)(0xf0|(c>>18));bytes[1]=(char)(0x80|((c>>12)&63));bytes[2]=(char)(0x80|((c>>6)&63));bytes[3]=(char)(0x80|(c&63));}
                break;
            default:return 0;
            }
        }
        if(n+count>=capacity)return 0;
        memcpy(out+n,bytes,count);n+=count;
    }
    if(**p!='"')return 0;
    ++*p;out[n]=0;return 1;
}
static int primitive(const char *value) {
    const unsigned char *p = (const unsigned char *)value;
    if (!strcmp(value,"true") || !strcmp(value,"false") || !strcmp(value,"null")) return 1;
    if (*p == '-') ++p;
    if (*p == '0') ++p;
    else { if (*p < '1' || *p > '9') return 0; while (*p >= '0' && *p <= '9') ++p; }
    if (*p == '.') { ++p; if (*p < '0' || *p > '9') return 0; while (*p >= '0' && *p <= '9') ++p; }
    if (*p == 'e' || *p == 'E') { ++p; if (*p == '+' || *p == '-') ++p; if (*p < '0' || *p > '9') return 0; while (*p >= '0' && *p <= '9') ++p; }
    return *p == 0;
}
static int parse(const char *p,object *o) {
    size_t i,n;field *f;const char *start;o->count=0;space(&p);if(*p++!='{')return 0;space(&p);
    while(*p!='}') {
        if(o->count==32)return 0;
        f=&o->fields[o->count];if(!string(&p,f->key,sizeof f->key))return 0;
        for(i=0;i<o->count;++i)if(!strcmp(o->fields[i].key,f->key))return 0;
        space(&p);if(*p++!=':')return 0;space(&p);f->string=*p=='"';
        if(f->string){if(!string(&p,f->value,sizeof f->value))return 0;}
        else{start=p;while(*p&&*p!=','&&*p!='}'&&!isspace((unsigned char)*p))++p;n=(size_t)(p-start);if(!n||n>=sizeof f->value)return 0;memcpy(f->value,start,n);f->value[n]=0;if(!primitive(f->value))return 0;}
        ++o->count;space(&p);if(*p=='}')break;if(*p++!=',')return 0;space(&p);if(*p=='}')return 0;
    }
    ++p;space(&p);return *p==0;
}
static const field *get(const object *o,const char *key) {size_t i;for(i=0;i<o->count;++i)if(!strcmp(o->fields[i].key,key))return &o->fields[i];return NULL;}
static const char *text(const object *o,const char *key,const char *fallback){const field *f=get(o,key);return f&&f->string?f->value:fallback;}
static int boolean(const object *o,const char *key){const field *f=get(o,key);return f&&!f->string&&!strcmp(f->value,"true");}
static int unsigned_value(const object *o,const char *key,uint64_t fallback,uint64_t *out) {
    char *end;const field *f=get(o,key);if(!f){*out=fallback;return 1;}if(!*f->value||f->value[0]=='-')return 0;errno=0;*out=strtoull(f->value,&end,10);return !errno&&!*end;
}
static int decode_key(const char *s,uint8_t out[32]) {size_t n;if(!s||strlen(s)!=64)return 0;return !sodium_hex2bin(out,32,s,64,NULL,&n,NULL)&&n==32;}
static int command(sc_host **host,const object *o,char *frame64,size_t framecap) {
    const char *cmd=text(o,"command",text(o,"cmd",text(o,"op","")));
    uint8_t secret[32],seed[32],server_seed[32],server_key[32],frame[SC_MAX_FRAME];
    const uint8_t *seedp=NULL;const field *f;int status,role;size_t length=0;uint64_t budget,capacity,count,revision;
    frame64[0]=0;
    if(!strcmp(cmd,"init")) {
        if(*host)return SC_ERR_ARGUMENT;
        role=!strcmp(text(o,"role",""),"device")?1:!strcmp(text(o,"role",""),"server")?2:0;
        if(!decode_key(text(o,"secret","3333333333333333333333333333333333333333333333333333333333333333"),secret))return SC_ERR_ARGUMENT;
        f=get(o,"key_seed");if(f&&strcmp(f->value,"null")){if(!f->string||!decode_key(f->value,seed))return SC_ERR_ARGUMENT;seedp=seed;}
        if(get(o,"server_public_key")){if(!decode_key(text(o,"server_public_key",""),server_key))return SC_ERR_ARGUMENT;}
        else{if(!decode_key(text(o,"server_seed","2222222222222222222222222222222222222222222222222222222222222222"),server_seed))return SC_ERR_ARGUMENT;status=sc_host_fixture_public(server_seed,server_key);if(status)return status;}
        status=sc_host_initialize(role,text(o,"storage",""),text(o,"serial","SAMPLE-001"),secret,seedp,server_key,boolean(o,"random_unavailable")||boolean(o,"provision_without_random"),host);
        sodium_memzero(secret,sizeof secret);sodium_memzero(seed,sizeof seed);sodium_memzero(server_seed,sizeof server_seed);
        if(!status&&get(o,"initial_revision")){if(!unsigned_value(o,"initial_revision",0,&revision))return SC_ERR_ARGUMENT;status=sc_host_fixture_revision(*host,revision);}return status;
    }
    if(!*host)return SC_ERR_ARGUMENT;
    if(!strcmp(cmd,"enrollment_enable"))return sc_host_enrollment_enable(*host);
    if(!strcmp(cmd,"enrollment_cancel"))return sc_host_enrollment_cancel(*host);
    if(!strcmp(cmd,"enrollment_begin")){uint64_t now,expires;if(!unsigned_value(o,"now",0,&now)||!unsigned_value(o,"expires",0,&expires))return SC_ERR_ARGUMENT;return sc_host_enrollment_begin(*host,now,expires);}
    if(!strcmp(cmd,"enrollment_approve")){uint64_t now;if(!decode_key(text(o,"challenge",""),secret)||!decode_key(text(o,"key",""),seed)||!unsigned_value(o,"now",0,&now))return SC_ERR_ARGUMENT;return sc_host_enrollment_approve(*host,secret,seed,now);}
    if(!strcmp(cmd,"state"))return SC_OK;
    if(!strcmp(cmd,"close")){sc_host_close(*host);*host=NULL;return SC_OK;}
    if(!strcmp(cmd,"name"))return sc_host_name(*host,text(o,"name",""));
    if(!strcmp(cmd,"report")) {
        char *end;long long temperature;f=get(o,"temperature");if(!f)f=get(o,"temperature_mC");if(!f||f->string)return SC_ERR_ARGUMENT;
        errno=0;temperature=strtoll(f->value,&end,10);if(errno||!*f->value||*end||temperature<INT32_MIN||temperature>INT32_MAX)return SC_ERR_ARGUMENT;
        return sc_host_report(*host,(int32_t)temperature);
    }
    if(!strcmp(cmd,"fail")){if(!unsigned_value(o,"count",1,&count)||count>UINT32_MAX)return SC_ERR_ARGUMENT;return sc_host_fail(*host,text(o,"operation",""),(unsigned)count);}
    if(!strcmp(cmd,"tx")) {
        if(!unsigned_value(o,"budget",512,&budget)||!unsigned_value(o,"capacity",512,&capacity)||capacity>65536||budget>SIZE_MAX)return SC_ERR_ARGUMENT;
        status=sc_host_outbound(*host,(size_t)budget,frame,capacity>sizeof frame?sizeof frame:(size_t)capacity,&length);
        if(status==SC_OK)sodium_bin2base64(frame64,framecap,frame,length,sodium_base64_VARIANT_ORIGINAL);
        return status;
    }
    if(!strcmp(cmd,"rx")||!strcmp(cmd,"rx_at")) {
        const char *encoded=text(o,"frame","");const char *end=NULL;
        if(sodium_base642bin(frame,sizeof frame,encoded,strlen(encoded),NULL,&length,&end,sodium_base64_VARIANT_ORIGINAL)||!end||*end)return SC_ERR_ARGUMENT;
        if(!strcmp(cmd,"rx_at")){uint64_t now;if(!unsigned_value(o,"now",0,&now))return SC_ERR_ARGUMENT;return sc_host_receive_at(*host,frame,length,now);}
        return sc_host_receive(*host,frame,length);
    }
    return SC_ERR_ARGUMENT;
}
int main(void) {
    char *line=NULL;size_t size=0;ssize_t n;object input;sc_host *host=NULL;char state[4096],frame[1024];int status;
    while((n=getline(&line,&size,stdin))>=0) {
        frame[0]=0;status=n<=65536&&(size_t)n==strlen(line)&&parse(line,&input)?command(&host,&input,frame,sizeof frame):SC_ERR_ARGUMENT;
        printf("{\"status\":\"%s\"",sc_host_status(status));
        if(frame[0])printf(",\"frame\":\"%s\"",frame);
        if(host&&sc_host_inspect(host,state,sizeof state)==SC_OK)printf(",\"state\":%s",state);
        puts("}");fflush(stdout);
    }
    free(line);sc_host_close(host);return 0;
}
