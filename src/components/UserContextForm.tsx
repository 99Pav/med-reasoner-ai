import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronUp, User } from "lucide-react";
import type { UserProfile } from "@/types/research";

interface Props {
  profile: UserProfile;
  onUpdate: (profile: UserProfile) => void;
}

export function UserContextForm({ profile, onUpdate }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [local, setLocal] = useState(profile);

  const handleSave = () => {
    onUpdate(local);
  };

  return (
    <Card className="border-border">
      <CardHeader
        className="cursor-pointer flex flex-row items-center justify-between py-3 px-4"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Patient Context</CardTitle>
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </CardHeader>
      {!collapsed && (
        <CardContent className="px-4 pb-4 pt-0 space-y-3">
          <div>
            <Label htmlFor="name" className="text-xs">Name (optional)</Label>
            <Input
              id="name"
              placeholder="e.g., John Smith"
              value={local.name}
              onChange={(e) => setLocal({ ...local, name: e.target.value })}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="disease" className="text-xs">Disease of Interest</Label>
            <Input
              id="disease"
              placeholder="e.g., Parkinson's disease"
              value={local.diseaseOfInterest}
              onChange={(e) => setLocal({ ...local, diseaseOfInterest: e.target.value })}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="location" className="text-xs">Location (optional)</Label>
            <Input
              id="location"
              placeholder="e.g., Toronto, Canada"
              value={local.location}
              onChange={(e) => setLocal({ ...local, location: e.target.value })}
              className="h-8 text-sm"
            />
          </div>
          <Button size="sm" className="w-full" onClick={handleSave}>
            Update Context
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
