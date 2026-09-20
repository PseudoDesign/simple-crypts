// Command go_docs extracts and validates the maintained Go binding API without
// loading cgo or executing native code. Generated resource IDs have their own gate.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
)

type entry struct {
	Name        string `json:"name"`
	Signature   string `json:"signature"`
	Description string `json:"description"`
}

func main() {
	files := token.NewFileSet()
	path := "bindings/go/simplecrypts.go"
	if len(os.Args) > 1 {
		path = os.Args[1]
	}
	source, err := parser.ParseFile(files, path, nil, parser.ParseComments)
	if err != nil {
		panic(err)
	}
	entries := []entry{}
	add := func(name string, node ast.Node, comment *ast.CommentGroup) {
		if comment == nil || comment.Text() == "" {
			panic("Undocumented Go API: " + name)
		}
		var buffer bytes.Buffer
		if err := format.Node(&buffer, files, node); err != nil {
			panic(err)
		}
		entries = append(entries, entry{name, buffer.String(), comment.Text()})
	}
	if source.Doc == nil {
		panic("Undocumented Go package")
	}
	for _, declaration := range source.Decls {
		switch d := declaration.(type) {
		case *ast.FuncDecl:
			if ast.IsExported(d.Name.Name) {
				name := d.Name.Name
				if d.Recv != nil {
					var receiver bytes.Buffer
					if err := format.Node(&receiver, files, d.Recv.List[0].Type); err != nil {
						panic(err)
					}
					name = receiver.String() + "." + name
				}
				add(name, d.Type, d.Doc)
			}
		case *ast.GenDecl:
			for _, specification := range d.Specs {
				t, ok := specification.(*ast.TypeSpec)
				if !ok || !ast.IsExported(t.Name.Name) {
					continue
				}
				comment := t.Doc
				if comment == nil {
					comment = d.Doc
				}
				add(t.Name.Name, t, comment)
				if fields, ok := t.Type.(*ast.StructType); ok {
					for _, field := range fields.Fields.List {
						for _, name := range field.Names {
							if ast.IsExported(name.Name) {
								add(t.Name.Name+"."+name.Name, field.Type, field.Doc)
							}
						}
					}
				}
			}
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(entries); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
