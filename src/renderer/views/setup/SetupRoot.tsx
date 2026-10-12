import type { JSX } from 'react';
import { useHashRoute, type WizardRoute } from './shared/useHashRoute';
import { WizardShell } from './wizard/WizardShell';
import { Step1Welcome } from './wizard/Step1Welcome';
import { Step2ApiKey } from './wizard/Step2ApiKey';
import { Step3Cables } from './wizard/Step3Cables';
import { Step4Devices } from './wizard/Step4Devices';
import { Step5MeetConfig } from './wizard/Step5MeetConfig';
import { Step6TestTranslation } from './wizard/Step6TestTranslation';
import { TroubleshootScreen } from './troubleshoot/TroubleshootScreen';
import { SettingsScreen } from './settings/SettingsScreen';

function renderStep(route: WizardRoute): JSX.Element {
  switch (route.step) {
    case 1: return <Step1Welcome />;
    case 2: return <Step2ApiKey mode={route.mode} />;
    case 3: return <Step3Cables mode={route.mode} />;
    case 4: return <Step4Devices mode={route.mode} />;
    case 5: return <Step5MeetConfig mode={route.mode} />;
    case 6: return <Step6TestTranslation mode={route.mode} />;
  }
}

export function SetupRoot(): JSX.Element {
  const route = useHashRoute();
  if (route.kind === 'settings') return <SettingsScreen section={route.section} />;
  if (route.kind === 'troubleshoot') return <TroubleshootScreen />;
  return (
    <WizardShell currentStep={route.step} totalSteps={6}>
      {renderStep(route)}
    </WizardShell>
  );
}
